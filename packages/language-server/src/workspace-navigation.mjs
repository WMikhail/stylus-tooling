import { performance } from "node:perf_hooks";

import { compatibleSymbolKind } from "./semantic-model.mjs";

/** @typedef {{readonly aborted: boolean, readonly reason?: unknown}} CancellationSignal */
/** @typedef {import("vscode-languageserver").Position} Position */
/** @typedef {import("vscode-languageserver").Location} Location */
/** @typedef {import("vscode-languageserver").Range} Range */
/** @typedef {import("vscode-languageserver").WorkspaceEdit} WorkspaceEdit */
/** @typedef {import("./semantic-model.mjs").SemanticModel} SemanticModel */
/** @typedef {import("./semantic-model.mjs").SemanticItem} SemanticItem */
/** @typedef {import("./semantic-model.mjs").SemanticReference} SemanticReference */
/** @typedef {import("./semantic-model.mjs").SemanticSymbol} SemanticSymbol */
/** @typedef {import("./import-resolver.mjs").ImportResolver} ImportResolver */
/**
 * @typedef {{
 *   uri: string,
 *   filePath: string,
 *   models: SemanticModel[],
 * }} NavigationDocument
 */

/** @param {SemanticSymbol} symbol @returns {Location} */
function locationForSymbol(symbol) {
  return { uri: symbol.uri, range: symbol.nameRange };
}

/** @returns {Range} */
function zeroRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
}

/** @param {Location[]} locations @returns {Location[]} */
function deduplicateLocations(locations) {
  /** @type {Map<string, Location>} */
  const unique = new Map();
  for (const location of locations) {
    const { start, end } = location.range;
    unique.set(
      `${location.uri}:${start.line}:${start.character}:${end.line}:${end.character}`,
      location,
    );
  }
  return [...unique.values()];
}

/** @param {SemanticSymbol} symbol @param {string} newName @returns {boolean} */
function validRename(symbol, newName) {
  if (typeof newName !== "string" || !newName) {
    return false;
  }
  if (
    symbol.kind === "variable" ||
    symbol.kind === "parameter" ||
    symbol.kind === "loop-variable"
  ) {
    return symbol.name.startsWith("$")
      ? /^\$-?[_a-zA-Z][\w-]*$/.test(newName)
      : /^-?[_a-zA-Z][\w-]*$/.test(newName);
  }
  if (
    symbol.kind === "function" ||
    symbol.kind === "mixin" ||
    symbol.kind === "keyframes"
  ) {
    return /^-?[_a-zA-Z][\w-]*$/.test(newName);
  }
  if (symbol.kind === "placeholder") {
    return /^\$-?[_a-zA-Z][\w-]*$/.test(newName);
  }
  if (symbol.kind === "selector") {
    if (symbol.name.startsWith(".")) {
      return /^\.-?[_a-zA-Z][\w-]*$/.test(newName);
    }
    if (symbol.name.startsWith("#")) {
      return /^#-?[_a-zA-Z][\w-]*$/.test(newName);
    }
    return /^-?[_a-zA-Z][\w-]*$/.test(newName);
  }
  return false;
}

/** An expected, user-facing refusal of an unsafe rename operation. */
export class RenameError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RenameError";
  }
}

/** Implements navigation and rename without owning workspace caches. */
export class WorkspaceNavigation {
  /**
   * @param {{
   *   getDocument: (uri: string) => Promise<NavigationDocument | null>,
   *   modelAt: (document: NavigationDocument, position: Position) => SemanticModel | null,
   *   symbolsAt: (uri: string, position: Position, signal: CancellationSignal | null) => Promise<{item: SemanticItem | null, symbols: SemanticSymbol[]}>,
   *   resolveReference: (model: SemanticModel, reference: SemanticReference, options?: {workspaceFallback?: boolean, signal?: CancellationSignal | null}) => Promise<SemanticSymbol[]>,
   *   importedSymbols: (model: SemanticModel, name: string, expectedKinds: string[], signal: CancellationSignal | null) => Promise<SemanticSymbol[]>,
   *   documents: () => Iterable<NavigationDocument>,
   *   namedSymbols: (name: string) => SemanticSymbol[],
   *   resolver: ImportResolver,
   *   recordDefinitionDuration: (durationMs: number) => void
   * }} host
   */
  constructor(host) {
    this.host = host;
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Location | Location[] | null>}
   */
  async definition(uri, position, signal = null) {
    const started = performance.now();
    const document = await this.host.getDocument(uri);
    if (!document) {
      return null;
    }
    const model = this.host.modelAt(document, position);
    const item = model?.itemAtPosition(position);
    if (!model || !item) {
      return null;
    }

    /** @type {Location[]} */
    let locations;
    if (item.type === "import") {
      const resolved = await this.host.resolver.resolve(
        item.value.specifier,
        document.filePath,
        signal,
      );
      locations = resolved.map((candidate) => ({
        uri: candidate.uri,
        range: zeroRange(),
      }));
    } else if (item.type === "symbol") {
      locations = [locationForSymbol(item.value)];
    } else {
      let symbols = await this.host.resolveReference(model, item.value, { signal });
      if (!symbols.length) {
        symbols = this.host
          .namedSymbols(item.value.name)
          .filter((symbol) => compatibleSymbolKind(symbol.kind, item.value.expectedKinds));
      }
      locations = symbols.map(locationForSymbol);
    }
    locations = deduplicateLocations(locations);
    this.host.recordDefinitionDuration(performance.now() - started);
    if (locations.length === 0) {
      return null;
    }
    return locations.length === 1 ? locations[0] : locations;
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {boolean} includeDeclaration
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Location[]>}
   */
  async references(uri, position, includeDeclaration = false, signal = null) {
    const document = await this.host.getDocument(uri);
    const model = document ? this.host.modelAt(document, position) : null;
    const item = model?.itemAtPosition(position);
    if (!model || !item || item.type === "import") {
      return [];
    }
    const targets =
      item.type === "symbol"
        ? [item.value]
        : await this.host.resolveReference(model, item.value, { signal });
    if (!targets.length) {
      return [];
    }
    const targetIds = new Set(targets.map((symbol) => symbol.id));
    const locations = includeDeclaration ? targets.map(locationForSymbol) : [];
    for (const candidateDocument of this.host.documents()) {
      for (const candidateModel of candidateDocument.models) {
        for (const reference of candidateModel.references) {
          if (signal?.aborted) {
            throw signal.reason ?? new Error("Reference search cancelled");
          }
          const resolved = await this.host.resolveReference(candidateModel, reference, {
            signal,
          });
          if (resolved.some((symbol) => targetIds.has(symbol.id))) {
            locations.push({ uri: reference.uri, range: reference.range });
          }
        }
      }
    }
    return deduplicateLocations(locations).sort(
      (left, right) =>
        left.uri.localeCompare(right.uri) ||
        left.range.start.line - right.range.start.line ||
        left.range.start.character - right.range.start.character,
    );
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<{range: import("vscode-languageserver").Range, placeholder: string}>}
   */
  async prepareRename(uri, position, signal = null) {
    const { item, symbols } = await this.host.symbolsAt(uri, position, signal);
    if (!item) {
      throw new RenameError("The cursor is not on a Stylus symbol.");
    }
    if (item.type === "import") {
      throw new RenameError("Import paths cannot be renamed as symbols.");
    }
    if (symbols.length === 0) {
      throw new RenameError(`No definition could be resolved for '${item.value.name}'.`);
    }
    if (symbols.length > 1) {
      throw new RenameError(
        `Rename is unsafe because '${item.value.name}' has multiple possible definitions.`,
      );
    }
    return {
      range: item.type === "symbol" ? item.value.nameRange : item.value.range,
      placeholder: item.value.name,
    };
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {string} newName
   * @param {CancellationSignal | null} signal
   * @returns {Promise<WorkspaceEdit>}
   */
  async rename(uri, position, newName, signal = null) {
    const { symbols } = await this.host.symbolsAt(uri, position, signal);
    if (symbols.length !== 1) {
      throw new RenameError(
        symbols.length
          ? "Rename is unsafe because the reference is ambiguous."
          : "Rename requires a uniquely resolved Stylus symbol.",
      );
    }
    const target = symbols[0];
    if (!validRename(target, newName)) {
      throw new RenameError(
        `'${newName}' is not a valid new name for a ${target.kind} named '${target.name}'.`,
      );
    }
    if (newName === target.name) {
      return { changes: {} };
    }

    const targetDocument = [...this.host.documents()].find(
      (document) => document.uri === target.uri,
    );
    const targetModel = targetDocument?.models.find(
      (model) => model.embedded.uri === target.embeddedUri,
    );
    const targetScope = targetModel?.scopeById.get(target.scopeId);
    const declarationConflict = targetScope?.symbolIds
      .map((id) => targetModel?.symbolById.get(id))
      .find(
        (symbol) =>
          symbol &&
          symbol.id !== target.id &&
          symbol.name === newName &&
          compatibleSymbolKind(symbol.kind, [target.kind]),
      );
    if (declarationConflict) {
      throw new RenameError(
        `Rename would conflict with ${declarationConflict.kind} '${newName}' in the same scope.`,
      );
    }

    /** @type {SemanticReference[]} */
    const references = [];
    for (const document of this.host.documents()) {
      for (const model of document.models) {
        for (const reference of model.references) {
          if (signal?.aborted) {
            throw signal.reason ?? new Error("Rename cancelled");
          }
          const resolved = await this.host.resolveReference(model, reference, { signal });
          if (!resolved.some((symbol) => symbol.id === target.id)) {
            continue;
          }
          const localConflict = model.resolveLocal(
            newName,
            reference.expectedKinds,
            reference.localNameStart,
            reference.scopeId,
          );
          if (localConflict.some((symbol) => symbol.id !== target.id)) {
            throw new RenameError(
              `Rename would make '${newName}' resolve to a different local symbol in ${reference.uri}.`,
            );
          }
          if (!localConflict.length) {
            const importedConflict = await this.host.importedSymbols(
              model,
              newName,
              reference.expectedKinds,
              signal,
            );
            if (importedConflict.some((symbol) => symbol.id !== target.id)) {
              throw new RenameError(
                `Rename would conflict with imported symbol '${newName}' in ${reference.uri}.`,
              );
            }
          }
          references.push(reference);
        }
      }
    }

    const changes =
      /** @type {Record<string, import("vscode-languageserver").TextEdit[]>} */ ({});
    /** @param {string} editUri @param {Range} range */
    const addEdit = (editUri, range) => {
      const edits = changes[editUri] ?? [];
      edits.push({ range, newText: newName });
      changes[editUri] = edits;
    };
    addEdit(target.uri, target.nameRange);
    for (const reference of references) {
      addEdit(reference.uri, reference.range);
    }
    for (const [editUri, edits] of Object.entries(changes)) {
      const unique = new Map();
      for (const edit of edits) {
        const { start, end } = edit.range;
        unique.set(`${start.line}:${start.character}:${end.line}:${end.character}`, edit);
      }
      changes[editUri] = [...unique.values()].sort(
        (left, right) =>
          right.range.start.line - left.range.start.line ||
          right.range.start.character - left.range.start.character,
      );
    }
    return { changes };
  }
}
