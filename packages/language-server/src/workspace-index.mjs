import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { extractEmbeddedDocuments } from "./embedded-documents.mjs";
import { DocumentUpdateCoordinator } from "./document-update-coordinator.mjs";
import { collectDiagnostics } from "./diagnostics.mjs";
import { contextualFileSystemError, isMissingPathError } from "./filesystem-errors.mjs";
import { ImportResolver } from "./import-resolver.mjs";
import { parseStylus } from "./parser.mjs";
import { discoverWorkspaceConfigurations } from "./static-configuration.mjs";
import { compatibleSymbolKind, buildSemanticModel } from "./semantic-model.mjs";
import { WorkspaceGraph } from "./workspace-graph.mjs";
import { WorkspaceAuthoring } from "./workspace-authoring.mjs";
import { RenameError, WorkspaceNavigation } from "./workspace-navigation.mjs";
import { ResolutionCache } from "./resolution-cache.mjs";
import {
  collectSourceFiles,
  isSourceFile,
  mapWithConcurrency,
} from "./workspace-scanner.mjs";
import {
  createWorkspaceSettings,
  normalizeWorkspaceConfiguration,
} from "./workspace-settings.mjs";
import { WorkspaceSymbolIndex } from "./workspace-symbol-index.mjs";
import { WorkspaceDocumentStore } from "./workspace-document-store.mjs";
import {
  canonicalPathKey,
  filePathToUri,
  normalizeFilePath,
  uriToFilePath,
} from "./protocol.mjs";

/** @typedef {{ readonly aborted: boolean, readonly reason?: unknown }} CancellationSignal */
/** @typedef {import("vscode-languageserver").Position} Position */
/** @typedef {import("vscode-languageserver").Location} Location */
/** @typedef {import("vscode-languageserver").WorkspaceEdit} WorkspaceEdit */
/** @typedef {import("vscode-languageserver").CompletionList} CompletionList */
/** @typedef {import("vscode-languageserver").Hover} Hover */
/** @typedef {import("vscode-languageserver").SignatureHelp} SignatureHelp */
/** @typedef {import("vscode-languageserver").DocumentSymbol} DocumentSymbol */
/** @typedef {import("vscode-languageserver").SymbolInformation} SymbolInformation */
/** @typedef {import("vscode-languageserver").Color} Color */
/** @typedef {import("vscode-languageserver").Range} Range */
/** @typedef {import("vscode-languageserver").ColorInformation} ColorInformation */
/** @typedef {import("vscode-languageserver").ColorPresentation} ColorPresentation */
/** @typedef {import("vscode-languageserver").Diagnostic} Diagnostic */
/** @typedef {import("./semantic-model.mjs").SemanticModel} SemanticModel */
/** @typedef {import("./semantic-model.mjs").SemanticItem} SemanticItem */
/** @typedef {import("./semantic-model.mjs").SemanticReference} SemanticReference */
/** @typedef {import("./semantic-model.mjs").SemanticSymbol} SemanticSymbol */
/** @typedef {import("./workspace-graph.mjs").ImportEdge} ImportEdge */
/** @typedef {import("./workspace-settings.mjs").WorkspaceSettingsOverride} WorkspaceSettingsOverride */
/** @typedef {{uri: string, order: number, via: string}} ResolutionEdge */
/** @typedef {{symbol: SemanticSymbol, depth: number, order: number}} ImportedSymbol */
/**
 * @typedef {{
 *   uri: string,
 *   filePath: string,
 *   text: string,
 *   open: boolean,
 *   stats: {mtimeMs: number, size: number} | null,
 *   models: SemanticModel[],
 *   embeddedErrors: unknown[],
 *   version: number
 * }} WorkspaceDocument
 */
/**
 * @typedef {{
 *   indexedDocuments: number,
 *   parsedDocuments: number,
 *   incrementalParses: number,
 *   cacheHits: number,
 *   lastIndexDurationMs: number,
 *   lastDefinitionDurationMs: number
 * }} WorkspaceMetrics
 */
/**
 * @typedef {{
 *   force?: boolean,
 *   stats?: import("node:fs").Stats,
 *   importDepth?: number,
 *   signal?: CancellationSignal | null
 * }} IndexFileOptions
 */

/** @param {string} parent @param {string} child @returns {boolean} */
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Incremental workspace index shared by every LSP handler. The index keeps host
 * documents, embedded syntax trees, semantic models, and import edges separate.
 */
export class WorkspaceIndex {
  /** @param {string[]} rootUris */
  constructor(rootUris = []) {
    this.rootPaths = /** @type {string[]} */ ([]);
    this.symbolIndex = new WorkspaceSymbolIndex();
    this.documentStore = new WorkspaceDocumentStore(this.symbolIndex);
    this.graph = new WorkspaceGraph();
    this.updates = new DocumentUpdateCoordinator();
    this.resolutionCache = new ResolutionCache();
    this.resolver = new ImportResolver();
    this.configurationMessages = /** @type {string[]} */ ([]);
    this.workspaceOverrides = /** @type {Record<string, Record<string, unknown>>} */ ({});
    this.settings = createWorkspaceSettings();
    this.metrics = /** @type {WorkspaceMetrics} */ ({
      indexedDocuments: 0,
      parsedDocuments: 0,
      incrementalParses: 0,
      cacheHits: 0,
      lastIndexDurationMs: 0,
      lastDefinitionDurationMs: 0,
    });
    this.ready = /** @type {Promise<void>} */ (Promise.resolve());
    this.authoring = new WorkspaceAuthoring({
      getDocument: (uri) => this.#document(uri),
      modelAt: (document, position) => this.#modelAt(document, position),
      symbolsAt: (uri, position, signal) => this.#symbolsAt(uri, position, signal),
      resolveReference: (model, reference, signal) =>
        this.resolveReference(model, reference, { signal }),
      allImportedSymbols: (model, signal) => this.#allImportedSymbols(model, signal),
      importedSymbols: (model, name, expectedKinds, signal) =>
        this.#importedSymbols(model, name, expectedKinds, signal),
      waitUntilReady: () => this.ready,
      workspaceSymbols: () => this.symbolIndex.values(),
      resolver: this.resolver,
      settings: () => this.settings,
    });
    this.navigation = new WorkspaceNavigation({
      getDocument: (uri) => this.#document(uri),
      modelAt: (document, position) => this.#modelAt(document, position),
      symbolsAt: (uri, position, signal) => this.#symbolsAt(uri, position, signal),
      resolveReference: (model, reference, options) =>
        this.resolveReference(model, reference, options),
      importedSymbols: (model, name, expectedKinds, signal) =>
        this.#importedSymbols(model, name, expectedKinds, signal),
      documents: () => this.documentStore.values(),
      namedSymbols: (name) => this.symbolIndex.named(name),
      resolver: this.resolver,
      recordDefinitionDuration: (durationMs) => {
        this.metrics.lastDefinitionDurationMs = durationMs;
      },
    });
    this.setRoots(rootUris);
  }

  /** @param {string[]} rootUris */
  setRoots(rootUris) {
    this.rootPaths = rootUris
      .map(uriToFilePath)
      .filter(/** @returns {filePath is string} */ (filePath) => filePath !== null)
      .map(normalizeFilePath)
      .sort((left, right) => right.length - left.length);
    this.resolver.setRoots(this.rootPaths);
  }

  /** @param {unknown} settings */
  configure(settings = {}) {
    const normalized = normalizeWorkspaceConfiguration(settings);
    this.settings = normalized.settings;
    this.workspaceOverrides = normalized.workspaceOverrides;
    this.resolver.configure(this.settings);
    this.#clearResolutionCache();
  }

  /**
   * @template T
   * @param {() => Promise<T> | T} callback
   * @returns {Promise<T>}
   */
  #queueWorkspaceOperation(callback) {
    const operation = this.ready.catch(() => undefined).then(callback);
    this.ready = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** @param {CancellationSignal | null} signal */
  refreshImports(signal = null) {
    return this.#queueWorkspaceOperation(async () => {
      await this.#loadWorkspaceConfigurations(signal);
      for (const document of [...this.documentStore.values()]) {
        await this.#updateImportEdges(document, 0, signal);
      }
      this.#clearResolutionCache();
    });
  }

  /** @param {CancellationSignal | null} signal @returns {Promise<WorkspaceMetrics>} */
  rebuild(signal = null) {
    return this.#queueWorkspaceOperation(() => this.#rebuild(signal));
  }

  /** @param {CancellationSignal | null} signal @returns {Promise<WorkspaceMetrics>} */
  async #rebuild(signal) {
    const started = performance.now();
    const existingUris = new Set(this.documentStore.keys());
    await this.#loadWorkspaceConfigurations(signal);
    const seen = new Set();
    const files = [];
    for (const rootPath of this.rootPaths) {
      const scan = await collectSourceFiles(rootPath, this.settings, signal);
      this.configurationMessages.push(...scan.messages);
      for (const filePath of scan.files) {
        const key = canonicalPathKey(filePath);
        if (!seen.has(key)) {
          seen.add(key);
          files.push(filePath);
        }
      }
    }
    await mapWithConcurrency(files, 16, (filePath) =>
      this.indexFile(filePath, { importDepth: 0, signal }),
    );

    for (const uri of existingUris) {
      await this.updates.pending(uri);
      const document = this.documentStore.get(uri);
      if (document) {
        await this.#updateImportEdges(document, 0, signal);
      }
    }

    const retainedUris = new Set(this.documentStore.openUris());
    for (const filePath of files) {
      retainedUris.add(filePathToUri(filePath));
    }
    for (const edge of this.#themeEdges()) {
      retainedUris.add(edge.uri);
    }
    const queue = [...retainedUris];
    let queueCursor = 0;
    while (queueCursor < queue.length) {
      const uri = queue[queueCursor++];
      for (const edge of this.graph.edgesFrom(uri)) {
        if (!retainedUris.has(edge.uri)) {
          retainedUris.add(edge.uri);
          queue.push(edge.uri);
        }
      }
    }

    for (const [uri, document] of this.documentStore.entries()) {
      if (!document.open && !retainedUris.has(uri)) {
        this.#removeDocument(uri);
      }
    }
    this.#clearResolutionCache();
    this.metrics.indexedDocuments = this.documentStore.size;
    this.metrics.lastIndexDurationMs = performance.now() - started;
    return this.metrics;
  }

  /** @param {string} key @returns {string | null} */
  #workspaceOverridePath(key) {
    const fromUri = key.startsWith("file:") ? uriToFilePath(key) : null;
    if (fromUri) return fromUri;
    if (path.isAbsolute(key)) return normalizeFilePath(key);
    for (const rootPath of this.rootPaths) {
      const candidate = path.resolve(rootPath, key);
      if (isInside(rootPath, candidate)) return candidate;
    }
    return null;
  }

  /** @param {CancellationSignal | null} signal */
  async #loadWorkspaceConfigurations(signal) {
    this.resolver.clearWorkspaceConfigurations();
    this.configurationMessages = [];
    if (this.settings.autoDetectAliases !== false) {
      for (const rootPath of this.rootPaths) {
        const discovered = await discoverWorkspaceConfigurations(
          rootPath,
          this.settings,
          signal,
        );
        this.configurationMessages.push(...discovered.messages);
        for (const configuration of discovered.configurations) {
          this.resolver.configureWorkspace(configuration.rootPath, configuration);
        }
      }
    }
    for (const [key, settings] of Object.entries(this.workspaceOverrides)) {
      const rootPath = this.#workspaceOverridePath(key);
      if (rootPath && settings && typeof settings === "object") {
        this.resolver.configureWorkspace(rootPath, settings);
      }
    }
  }

  /** @param {string} filePath @returns {string | null} */
  rootFor(filePath) {
    return this.rootPaths.find((rootPath) => isInside(rootPath, filePath)) ?? null;
  }

  #clearResolutionCache() {
    this.resolutionCache.clear();
  }

  #clearWorkspaceResolutionCache() {
    this.resolutionCache.clearWorkspace();
  }

  /** @param {string} uri */
  #removeDocument(uri) {
    const previous = this.documentStore.get(uri);
    if (!previous) {
      return;
    }
    this.#clearWorkspaceResolutionCache();
    this.graph.removeEdges(uri);
    this.documentStore.remove(uri);
    this.#invalidate(uri);
  }

  /** @param {string} uri @returns {Set<string>} */
  #invalidate(uri) {
    const affected = this.graph.affectedUris(uri);
    this.resolutionCache.invalidate(affected);
    return affected;
  }

  /**
   * @param {string} uri
   * @param {string} filePath
   * @param {string} text
   * @param {{open?: boolean, stats?: {mtimeMs: number, size: number} | null, importDepth: number, signal: CancellationSignal | null}} options
   * @returns {Promise<WorkspaceDocument | null>}
   */
  async #replaceDocument(uri, filePath, text, { open, stats, importDepth, signal }) {
    const previous = this.documentStore.get(uri);
    if (previous && previous.text === text) {
      previous.open = open ?? previous.open;
      previous.stats = stats ?? previous.stats;
      this.metrics.cacheHits += 1;
      return previous;
    }

    const generation = this.updates.nextDocumentVersion(uri);
    const extracted = await extractEmbeddedDocuments(uri, text);
    /** @type {SemanticModel[]} */
    const models = [];
    try {
      for (const embedded of extracted.documents) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Document analysis cancelled");
        }
        const previousModel = previous?.models.find(
          (candidate) =>
            candidate.embedded.index === embedded.index &&
            candidate.embedded.kind === embedded.kind,
        );
        const parsed = await parseStylus(
          embedded.text,
          previousModel?.parsed ?? null,
          signal,
        );
        const model = await buildSemanticModel(embedded, parsed);
        models.push(model);
        this.metrics.parsedDocuments += 1;
        if (parsed.incremental) {
          this.metrics.incrementalParses += 1;
        }
      }
    } catch (error) {
      for (const model of models) {
        model.dispose();
      }
      throw error;
    }

    if (!this.updates.isCurrentDocumentVersion(uri, generation)) {
      for (const model of models) {
        model.dispose();
      }
      return this.documentStore.get(uri) ?? null;
    }

    const document = /** @type {WorkspaceDocument} */ ({
      uri,
      filePath,
      text,
      open: Boolean(open),
      stats: stats ?? null,
      models,
      embeddedErrors: extracted.errors,
      version: generation,
    });
    this.#clearWorkspaceResolutionCache();
    this.documentStore.replace(document);
    await this.#updateImportEdges(document, importDepth, signal);
    this.#invalidate(uri);
    this.metrics.indexedDocuments = this.documentStore.size;
    return document;
  }

  /**
   * @param {WorkspaceDocument} document
   * @param {number} importDepth
   * @param {CancellationSignal | null} signal
   */
  async #updateImportEdges(document, importDepth, signal) {
    /** @type {ImportEdge[]} */
    const edges = [];
    let order = 0;
    const implicit = await this.resolver.resolveImplicit(document.filePath, signal);
    for (const model of document.models) {
      for (const candidate of implicit) {
        if (candidate.uri === document.uri) {
          continue;
        }
        edges.push({
          uri: candidate.uri,
          importId: null,
          embeddedUri: model.embedded.uri,
          order: -1,
          via: candidate.via,
        });
        if (
          isSourceFile(candidate.filePath) &&
          importDepth < this.settings.maxImportDepth &&
          !this.documentStore.has(candidate.uri)
        ) {
          await this.indexFile(candidate.filePath, {
            importDepth: importDepth + 1,
            signal,
          });
        }
      }
      for (const imported of model.imports) {
        const resolved = await this.resolver.resolve(
          imported.specifier,
          document.filePath,
          signal,
        );
        imported.resolvedUris = resolved.map((candidate) => candidate.uri);
        for (const candidate of resolved) {
          edges.push({
            uri: candidate.uri,
            importId: imported.id,
            embeddedUri: model.embedded.uri,
            order: order++,
            via: candidate.via,
          });
          if (
            isSourceFile(candidate.filePath) &&
            importDepth < this.settings.maxImportDepth &&
            !this.documentStore.has(candidate.uri)
          ) {
            await this.indexFile(candidate.filePath, {
              importDepth: importDepth + 1,
              signal,
            });
          }
        }
      }
    }
    this.graph.replaceEdges(document.uri, edges);
  }

  /**
   * @param {string} uri
   * @param {string} filePath
   * @param {string} text
   * @param {{open?: boolean, stats?: {mtimeMs: number, size: number} | null, importDepth: number, signal: CancellationSignal | null}} options
   * @returns {Promise<WorkspaceDocument | null>}
   */
  async #scheduleDocument(uri, filePath, text, options) {
    return this.updates.schedule(
      uri,
      options.signal,
      () => this.documentStore.get(uri) ?? null,
      (signal) =>
        this.#replaceDocument(uri, filePath, text, {
          ...options,
          signal,
        }),
    );
  }

  /** @param {string} uri @param {string} text @returns {Promise<WorkspaceDocument | null>} */
  openDocument(uri, text) {
    const filePath = uriToFilePath(uri);
    if (!filePath) {
      return Promise.resolve(null);
    }
    this.documentStore.open(uri, text);
    return this.#scheduleDocument(uri, filePath, text, {
      open: true,
      stats: null,
      importDepth: 0,
      signal: null,
    });
  }

  /** @param {string} uri @param {string} text @returns {Promise<WorkspaceDocument | null>} */
  changeDocument(uri, text) {
    return this.openDocument(uri, text);
  }

  /** @param {string} uri @returns {Promise<WorkspaceDocument | null>} */
  async closeDocument(uri) {
    this.documentStore.close(uri);
    const filePath = uriToFilePath(uri);
    if (!filePath) {
      this.#removeDocument(uri);
      return null;
    }
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        this.#removeDocument(uri);
        return null;
      }
      return this.indexFile(filePath, { force: true, stats });
    } catch (error) {
      if (isMissingPathError(error)) {
        this.#removeDocument(uri);
        return null;
      }
      throw contextualFileSystemError("Unable to inspect closed document", filePath, error);
    }
  }

  /**
   * @param {string} filePath
   * @param {IndexFileOptions} options
   * @returns {Promise<WorkspaceDocument | null>}
   */
  async indexFile(filePath, options = {}) {
    const normalizedPath = normalizeFilePath(filePath);
    const key = canonicalPathKey(normalizedPath);
    return this.updates.deduplicateFile(key, () =>
      this.#indexFile(normalizedPath, options),
    );
  }

  /**
   * @param {string} filePath
   * @param {IndexFileOptions} options
   * @returns {Promise<WorkspaceDocument | null>}
   */
  async #indexFile(filePath, options) {
    const uri = filePathToUri(filePath);
    const openText = this.documentStore.openText(uri);
    if (openText !== undefined) {
      return this.documentStore.get(uri) ?? this.openDocument(uri, openText);
    }
    let stats = options.stats;
    try {
      stats ??= await fs.stat(filePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        this.#removeDocument(uri);
        return null;
      }
      throw contextualFileSystemError("Unable to inspect Stylus source", filePath, error);
    }
    if (
      !stats.isFile() ||
      stats.size > this.settings.maxFileSize ||
      !isSourceFile(filePath)
    ) {
      return null;
    }
    const previous = this.documentStore.get(uri);
    if (
      !options.force &&
      previous?.stats?.mtimeMs === stats.mtimeMs &&
      previous?.stats?.size === stats.size
    ) {
      this.metrics.cacheHits += 1;
      return previous;
    }
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        this.#removeDocument(uri);
        return null;
      }
      throw contextualFileSystemError("Unable to read Stylus source", filePath, error);
    }
    return this.#scheduleDocument(uri, filePath, text, {
      open: false,
      stats: { mtimeMs: stats.mtimeMs, size: stats.size },
      importDepth: options.importDepth ?? 0,
      signal: options.signal ?? null,
    });
  }

  /** @param {string} uri */
  async removeFileUri(uri) {
    if (this.documentStore.isOpen(uri)) {
      const document = this.documentStore.get(uri);
      if (document) {
        document.stats = null;
      }
      return;
    }
    const dependents = [...this.graph.dependentsOf(uri)];
    this.resolver.clearCache();
    this.#removeDocument(uri);
    for (const dependentUri of dependents) {
      const dependent = this.documentStore.get(dependentUri);
      if (dependent) {
        await this.#updateImportEdges(dependent, 0, null);
      }
    }
    this.#clearResolutionCache();
  }

  async refreshUnresolvedImports() {
    this.resolver.clearCache();
    const candidates = [...this.documentStore.values()].filter((document) =>
      document.models.some((model) =>
        model.imports.some((imported) => imported.resolvedUris.length === 0),
      ),
    );
    for (const document of candidates) {
      await this.#updateImportEdges(document, 0, null);
    }
    this.#clearResolutionCache();
  }

  /** @param {string} uri @returns {Promise<WorkspaceDocument | null>} */
  async #document(uri) {
    await this.ready;
    await this.updates.pending(uri);
    let document = this.documentStore.get(uri);
    if (!document) {
      const filePath = uriToFilePath(uri);
      if (filePath) {
        const indexed = await this.indexFile(filePath);
        if (indexed) {
          document = indexed;
        }
      }
    }
    return document ?? null;
  }

  /** @param {{models: SemanticModel[]}} document @param {Position} position */
  #modelAt(document, position) {
    return (
      document.models.find((model) => model.embeddedAtPosition(position) !== null) ?? null
    );
  }

  /**
   * @param {WorkspaceDocument | null | undefined} document
   * @param {string} name
   * @param {string[]} expectedKinds
   * @returns {SemanticSymbol[]}
   */
  #exportedSymbols(document, name, expectedKinds) {
    /** @type {SemanticSymbol[]} */
    const result = [];
    for (const model of document?.models ?? []) {
      const fileScope = model.scopes.find((scope) => scope.type === "file");
      for (const symbol of model.symbols) {
        if (
          symbol.scopeId === fileScope?.id &&
          symbol.name === name &&
          compatibleSymbolKind(symbol.kind, expectedKinds)
        ) {
          result.push(symbol);
        }
      }
    }
    result.sort((left, right) => right.declarationOrder - left.declarationOrder);
    return result.length ? [result[0]] : [];
  }

  /**
   * @param {WorkspaceDocument | null | undefined} document
   * @returns {SemanticSymbol[]}
   */
  #exportedAllSymbols(document) {
    /** @type {SemanticSymbol[]} */
    const result = [];
    for (const model of document?.models ?? []) {
      const fileScope = model.scopes.find((scope) => scope.type === "file");
      for (const symbol of model.symbols) {
        if (symbol.scopeId === fileScope?.id) {
          result.push(symbol);
        }
      }
    }
    return result;
  }

  /** @returns {ResolutionEdge[]} */
  #themeEdges() {
    const active = this.settings.activeTheme;
    const themes = this.settings.themes;
    const configured =
      active && themes && typeof themes === "object" ? themes[active] : null;
    const values = Array.isArray(configured) ? configured : configured ? [configured] : [];
    /** @type {ResolutionEdge[]} */
    const result = [];
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }
      for (const rootPath of this.rootPaths) {
        const filePath = path.isAbsolute(value) ? value : path.resolve(rootPath, value);
        result.push({ uri: filePathToUri(filePath), order: -1, via: "active-theme" });
      }
    }
    return result;
  }

  /**
   * @param {SemanticModel} model
   * @param {string} name
   * @param {string[]} expectedKinds
   * @param {CancellationSignal | null} signal
   * @returns {Promise<SemanticSymbol[]>}
   */
  async #importedSymbols(model, name, expectedKinds, signal = null) {
    const initial = [
      ...this.graph
        .edgesFrom(model.uri)
        .filter((edge) => edge.embeddedUri === model.embedded.uri),
      ...this.#themeEdges(),
    ].sort((left, right) => right.order - left.order);
    const queue = initial.map((edge) => ({ edge, depth: 1 }));
    let cursor = 0;
    /** @type {Map<string, number>} */
    const visitedDepth = new Map();
    /** @type {ImportedSymbol[]} */
    const matches = [];
    while (cursor < queue.length) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Symbol resolution cancelled");
      }
      const { edge, depth } = queue[cursor++];
      if (depth > this.settings.maxImportDepth) {
        continue;
      }
      const previousDepth = visitedDepth.get(edge.uri);
      if (previousDepth !== undefined && previousDepth <= depth) {
        continue;
      }
      visitedDepth.set(edge.uri, depth);
      await this.updates.pending(edge.uri);
      let target = this.documentStore.get(edge.uri);
      if (!target) {
        const targetPath = uriToFilePath(edge.uri);
        if (targetPath && isSourceFile(targetPath)) {
          const indexed = await this.indexFile(targetPath, {
            importDepth: depth,
            signal,
          });
          if (indexed) {
            target = indexed;
          }
        }
      }
      for (const symbol of this.#exportedSymbols(target, name, expectedKinds)) {
        matches.push({ symbol, depth, order: edge.order });
      }
      const nested = [...this.graph.edgesFrom(edge.uri)].sort(
        (left, right) => right.order - left.order,
      );
      for (const nestedEdge of nested) {
        queue.push({ edge: nestedEdge, depth: depth + 1 });
      }
    }
    if (!matches.length) {
      return [];
    }
    const closest = Math.min(...matches.map((match) => match.depth));
    return matches
      .filter((match) => match.depth === closest)
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          right.order - left.order ||
          left.symbol.uri.localeCompare(right.symbol.uri),
      )
      .map((match) => match.symbol);
  }

  /**
   * @param {SemanticModel} model
   * @param {CancellationSignal | null} signal
   * @returns {Promise<ImportedSymbol[]>}
   */
  async #allImportedSymbols(model, signal = null) {
    const initial = [
      ...this.graph
        .edgesFrom(model.uri)
        .filter((edge) => edge.embeddedUri === model.embedded.uri),
      ...this.#themeEdges(),
    ].sort((left, right) => right.order - left.order);
    const queue = initial.map((edge) => ({ edge, depth: 1 }));
    let cursor = 0;
    const visited = new Set();
    /** @type {ImportedSymbol[]} */
    const result = [];
    while (cursor < queue.length) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Completion cancelled");
      }
      const { edge, depth } = queue[cursor++];
      if (visited.has(edge.uri) || depth > this.settings.maxImportDepth) {
        continue;
      }
      visited.add(edge.uri);
      await this.updates.pending(edge.uri);
      let target = this.documentStore.get(edge.uri);
      if (!target) {
        const targetPath = uriToFilePath(edge.uri);
        if (targetPath && isSourceFile(targetPath)) {
          const indexed = await this.indexFile(targetPath, {
            importDepth: depth,
            signal,
          });
          if (indexed) {
            target = indexed;
          }
        }
      }
      for (const symbol of this.#exportedAllSymbols(target)) {
        result.push({ symbol, depth, order: edge.order });
      }
      for (const nested of [...this.graph.edgesFrom(edge.uri)].sort(
        (left, right) => right.order - left.order,
      )) {
        queue.push({ edge: nested, depth: depth + 1 });
      }
    }
    return result;
  }

  /**
   * @param {SemanticModel} model
   * @param {SemanticReference} reference
   * @param {{workspaceFallback?: boolean, signal?: CancellationSignal | null}} options
   * @returns {Promise<SemanticSymbol[]>}
   */
  async resolveReference(
    model,
    reference,
    { workspaceFallback = true, signal = null } = {},
  ) {
    const resolutionMode = workspaceFallback ? "workspace" : "imports";
    const cacheKey = `${model.uri}\0${model.embedded.index}\0${reference.id}\0${resolutionMode}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached) {
      const result = await cached;
      reference.resolvedSymbolIds = result.map((symbol) => symbol.id);
      return result;
    }
    const operation = (async () => {
      const local = model.resolveLocal(
        reference.name,
        reference.expectedKinds,
        reference.localNameStart,
        reference.scopeId,
      );
      if (local.length) {
        return local;
      }
      const imported = await this.#importedSymbols(
        model,
        reference.name,
        reference.expectedKinds,
        signal,
      );
      if (imported.length) {
        return imported;
      }
      if (!workspaceFallback) {
        return [];
      }
      const workspace = this.symbolIndex
        .named(reference.name)
        .filter(
          (symbol) =>
            symbol.uri !== model.uri &&
            compatibleSymbolKind(symbol.kind, reference.expectedKinds) &&
            this.documentStore
              .get(symbol.uri)
              ?.models.some((candidate) =>
                candidate.scopes.some(
                  (scope) => scope.type === "file" && scope.id === symbol.scopeId,
                ),
              ),
        );
      return workspace.length === 1 ? workspace : [];
    })();
    const result = await this.resolutionCache.track(
      cacheKey,
      model.uri,
      workspaceFallback,
      operation,
    );
    reference.resolvedSymbolIds = result.map((symbol) => symbol.id);
    return result;
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Location | Location[] | null>}
   */
  definition(uri, position, signal = null) {
    return this.navigation.definition(uri, position, signal);
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {boolean} includeDeclaration
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Location[]>}
   */
  references(uri, position, includeDeclaration = false, signal = null) {
    return this.navigation.references(uri, position, includeDeclaration, signal);
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   */
  async #symbolsAt(uri, position, signal = null) {
    const document = await this.#document(uri);
    const model = document ? this.#modelAt(document, position) : null;
    const item = model?.itemAtPosition(position) ?? null;
    if (!document || !model || !item || item.type === "import") {
      return { item, symbols: [] };
    }
    const symbols =
      item.type === "symbol"
        ? [item.value]
        : await this.resolveReference(model, item.value, { signal });
    return { item, symbols };
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<{range: Range, placeholder: string}>}
   */
  prepareRename(uri, position, signal = null) {
    return this.navigation.prepareRename(uri, position, signal);
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {string} newName
   * @param {CancellationSignal | null} signal
   * @returns {Promise<WorkspaceEdit>}
   */
  rename(uri, position, newName, signal = null) {
    return this.navigation.rename(uri, position, newName, signal);
  }

  /** @param {string} uri @returns {Promise<DocumentSymbol[]>} */
  documentSymbols(uri) {
    return this.authoring.documentSymbols(uri);
  }

  /**
   * @param {string} query
   * @param {CancellationSignal | null} signal
   * @returns {Promise<SymbolInformation[]>}
   */
  workspaceSymbols(query = "", signal = null) {
    return this.authoring.workspaceSymbols(query, signal);
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<CompletionList>}
   */
  completion(uri, position, signal = null) {
    return this.authoring.completion(uri, position, signal);
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Hover | null>}
   */
  hover(uri, position, signal = null) {
    return this.authoring.hover(uri, position, signal);
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<SignatureHelp | null>}
   */
  signatureHelp(uri, position, signal = null) {
    return this.authoring.signatureHelp(uri, position, signal);
  }

  /** @param {string} uri @returns {Promise<ColorInformation[]>} */
  documentColors(uri) {
    return this.authoring.documentColors(uri);
  }

  /**
   * @param {Color} color
   * @param {Range} range
   * @returns {ColorPresentation[]}
   */
  colorPresentations(color, range) {
    return this.authoring.colorPresentations(color, range);
  }

  /**
   * @param {string} uri
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Diagnostic[]>}
   */
  async diagnostics(uri, signal = null) {
    const document = await this.#document(uri);
    if (!document) {
      return [];
    }
    /** @type {Map<string, string[]>} */
    const resolvedSymbolIdsByReference = new Map();
    for (const model of document.models) {
      for (const reference of model.references) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Diagnostics cancelled");
        }
        const resolved = await this.resolveReference(model, reference, {
          workspaceFallback: false,
          signal,
        });
        resolvedSymbolIdsByReference.set(
          reference.id,
          resolved.map((symbol) => symbol.id),
        );
      }
    }
    return collectDiagnostics({
      document,
      settings: this.settings,
      cyclicImportIds: this.graph.cyclicImportIds(uri, this.settings.maxImportDepth),
      resolvedSymbolIdsByReference,
    });
  }

  /** @param {string} uri @returns {string[]} */
  affectedUris(uri) {
    return [...this.graph.affectedUris(uri)];
  }

  /** @returns {string[]} */
  openUris() {
    return this.documentStore.openUris();
  }

  /** @returns {string[]} */
  documentUris() {
    return this.documentStore.documentUris();
  }

  /** @returns {string[]} */
  configurationLogMessages() {
    return [...this.configurationMessages];
  }

  /** @returns {number} */
  diagnosticsDebounceMs() {
    return Math.max(0, this.settings.diagnostics?.debounceMs ?? 150);
  }

  /** @returns {WorkspaceMetrics & {syntaxTrees: number, symbols: number, importEdges: number}} */
  snapshotMetrics() {
    return {
      ...this.metrics,
      syntaxTrees: [...this.documentStore.values()].reduce(
        (count, document) => count + document.models.length,
        0,
      ),
      symbols: this.symbolIndex.size,
      importEdges: this.graph.size,
    };
  }
}

export { RenameError };
export { filePathToUri, uriToFilePath } from "./protocol.mjs";
