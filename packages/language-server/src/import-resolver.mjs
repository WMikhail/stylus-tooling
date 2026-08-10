import { promises as fs } from "node:fs";
import path from "node:path";

import { isSafeGlobPattern, safeMinimatch } from "./glob-utils.mjs";
import {
  canonicalPathKey,
  filePathToUri,
  isWindowsPath,
  normalizeFilePath,
  uriToFilePath,
} from "./protocol.mjs";
import { contextualFileSystemError, isMissingPathError } from "./filesystem-errors.mjs";
import {
  createWorkspaceSettings,
  createWorkspaceSettingsOverride,
  mergeWorkspaceSettings,
} from "./workspace-settings.mjs";

/** @typedef {{readonly aborted: boolean, readonly reason?: unknown}} CancellationSignal */
/** @typedef {import("./workspace-settings.mjs").WorkspaceSettings} WorkspaceSettings */
/** @typedef {{basePath: string, via?: string}} ResolverCandidateBase */
/**
 * @typedef {{
 *   specifier: string,
 *   importerPath: string,
 *   rootPath: string,
 *   settings: WorkspaceSettings
 * }} ResolverContext
 */
/** @typedef {Omit<ResolverContext, "specifier">} ImplicitResolverContext */
/** @typedef {{filePath: string, uri: string, via: string}} ResolvedImport */
/** @typedef {{label: string, kind: "file" | "folder" | "module", via: string}} ImportCompletion */
/** @typedef {{items: ImportCompletion[], isIncomplete: boolean}} ImportCompletionResult */
/**
 * @typedef {{
 *   maxMatches: number,
 *   maxDirectories: number,
 *   maxEntries: number,
 *   maxDepth: number,
 *   maxBraceExpansions: number,
 *   boundary: string | null,
 *   signal: CancellationSignal | null
 * }} GlobWalkOptions
 */
/**
 * @typedef {import("./workspace-settings.mjs").WorkspaceSettingsOverride & {
 *   rootPath: string
 * }} ResolverWorkspaceSettings
 */

const STYLUS_EXTENSIONS = new Set([".styl", ".stylus"]);
const GLOB_MAGIC = /[*?[\]{}]/;

/** @param {string} filePath */
async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw contextualFileSystemError("Unable to inspect import candidate", filePath, error);
  }
}

/** @param {string} directory */
async function directoryExists(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw contextualFileSystemError("Unable to inspect import directory", directory, error);
  }
}

/** @param {string} value */
function pathApi(value) {
  return isWindowsPath(value) ? path.win32 : path;
}

/** @param {string} base @param {string} value */
function resolvePath(base, value) {
  if (isWindowsPath(base) || isWindowsPath(value)) {
    return path.win32.resolve(base, value.replaceAll("/", "\\"));
  }
  return path.resolve(base, value);
}

/** @param {string} filePath */
function dirname(filePath) {
  return pathApi(filePath).dirname(filePath);
}

/** @param {string} base @param {...string} parts */
function joinPath(base, ...parts) {
  return pathApi(base).join(base, ...parts);
}

/** @param {string} base @param {string} target */
function relativePath(base, target) {
  return pathApi(base).relative(base, target);
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const relative = relativePath(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !pathApi(relative).isAbsolute(relative))
  );
}

/** @param {string} specifier */
function withoutQueryOrFragment(specifier) {
  if (specifier.startsWith("file:")) {
    return specifier;
  }
  const query = specifier.search(/[?#]/);
  return query === -1 ? specifier : specifier.slice(0, query);
}

/** @param {string} specifier */
function normalizeSpecifier(specifier) {
  return withoutQueryOrFragment(specifier.trim()).replaceAll("\\", "/");
}

/** @param {string} specifier @param {string} alias */
function aliasMatches(specifier, alias) {
  const exactOnly = alias.endsWith("$");
  const name = exactOnly ? alias.slice(0, -1) : alias;
  return specifier === name || (!exactOnly && specifier.startsWith(`${name}/`));
}

/** @param {string} specifier @param {string} alias */
function aliasSuffix(specifier, alias) {
  const name = alias.endsWith("$") ? alias.slice(0, -1) : alias;
  return specifier.slice(name.length).replace(/^\//, "");
}

/** Expand an extensionless Stylus import in deterministic preference order. */
/** @param {string} basePath @returns {Promise<string[]>} */
export async function sourceFileCandidates(basePath) {
  const api = pathApi(basePath);
  const extension = api.extname(basePath).toLowerCase();
  const baseName = api.basename(basePath);
  const candidates = STYLUS_EXTENSIONS.has(extension)
    ? [basePath]
    : [
        basePath,
        `${basePath}.styl`,
        `${basePath}.stylus`,
        api.join(basePath, "index.styl"),
        api.join(basePath, "index.stylus"),
        api.join(basePath, `${baseName}.styl`),
        api.join(basePath, `${baseName}.stylus`),
      ];
  const result = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      result.push(normalizeFilePath(candidate));
    }
  }
  return result;
}

/** @param {string} basePath */
async function packageSourceFileCandidates(basePath) {
  try {
    const packageJson = JSON.parse(
      await fs.readFile(joinPath(basePath, "package.json"), "utf8"),
    );
    if (typeof packageJson.main === "string" && packageJson.main) {
      return sourceFileCandidates(resolvePath(basePath, packageJson.main));
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && !isMissingPathError(error)) {
      throw contextualFileSystemError(
        "Unable to read import package metadata",
        joinPath(basePath, "package.json"),
        error,
      );
    }
    // Missing or invalid package metadata falls back to Stylus directory lookup.
  }
  return sourceFileCandidates(basePath);
}

/** @param {string} specifier */
function isPackageRootSpecifier(specifier) {
  const segments = specifier.split("/").filter(Boolean);
  return segments[0]?.startsWith("@") ? segments.length === 2 : segments.length === 1;
}

/**
 * @param {string} filePath
 * @param {string | null} boundary
 */
function ancestorDirectories(filePath, boundary = null) {
  const api = pathApi(filePath);
  const result = [];
  let current = api.dirname(filePath);
  while (true) {
    result.push(current);
    if (boundary && canonicalPathKey(current) === canonicalPathKey(boundary)) {
      break;
    }
    const parent = api.dirname(current);
    if (parent === current || (boundary && !isInside(boundary, parent))) {
      break;
    }
    current = parent;
  }
  return result;
}

/**
 * @param {string} root
 * @param {string} normalizedPattern
 * @param {GlobWalkOptions} options
 */
async function walkStylusFiles(root, normalizedPattern, options) {
  const result = [];
  const queue = [{ directory: root, depth: 0 }];
  let cursor = 0;
  let directories = 0;
  let entriesSeen = 0;
  while (
    cursor < queue.length &&
    result.length < options.maxMatches &&
    directories < options.maxDirectories &&
    entriesSeen < options.maxEntries
  ) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Import glob resolution cancelled");
    }
    const { directory, depth } = queue[cursor++];
    directories += 1;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw contextualFileSystemError(
        "Unable to enumerate import glob directory",
        directory,
        error,
      );
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > options.maxEntries) {
        break;
      }
      const entryPath = joinPath(directory, entry.name);
      if (entry.isDirectory() && depth < options.maxDepth) {
        queue.push({ directory: entryPath, depth: depth + 1 });
      } else if (
        entry.isFile() &&
        STYLUS_EXTENSIONS.has(pathApi(entry.name).extname(entry.name).toLowerCase()) &&
        safeMinimatch(entryPath.replaceAll("\\", "/"), normalizedPattern, {
          nocase: isWindowsPath(entryPath),
          maxBraceExpansions: options.maxBraceExpansions,
        })
      ) {
        result.push(entryPath);
        if (result.length >= options.maxMatches) {
          break;
        }
      }
    }
  }
  return result;
}

/** @param {string} absolutePattern @param {GlobWalkOptions} options */
async function expandGlob(absolutePattern, options) {
  const normalizedPattern = absolutePattern.replaceAll("\\", "/");
  if (!isSafeGlobPattern(normalizedPattern, options.maxBraceExpansions)) {
    return [];
  }
  const magicIndex = normalizedPattern.search(GLOB_MAGIC);
  if (magicIndex === -1) {
    return sourceFileCandidates(absolutePattern);
  }
  const slash = normalizedPattern.lastIndexOf("/", magicIndex);
  const rootText = slash <= 0 ? "/" : normalizedPattern.slice(0, slash);
  const root = isWindowsPath(rootText) ? rootText.replaceAll("/", "\\") : rootText;
  if (
    (options.boundary && !isInside(options.boundary, root)) ||
    !(await directoryExists(root))
  ) {
    return [];
  }
  return (await walkStylusFiles(root, normalizedPattern, options))
    .map(normalizeFilePath)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Optional resolver extension. Presets only contribute candidate base paths;
 * canonicalization and filesystem checks remain centralized in ImportResolver.
 */
export class ResolverPreset {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {ResolverContext} _context
   * @returns {Promise<ResolverCandidateBase[]>}
   */
  async candidateBases(_context) {
    void _context;
    return [];
  }

  /**
   * @param {ImplicitResolverContext} _context
   * @returns {Promise<ResolverCandidateBase[]>}
   */
  async implicitCandidateBases(_context) {
    void _context;
    return [];
  }

  clearCache() {}
}

/** Quasar-specific behavior, isolated from ordinary Stylus/Node resolution. */
export class QuasarResolverPreset extends ResolverPreset {
  constructor() {
    super("quasar");
    this.detectionCache = /** @type {Map<string, Promise<boolean>>} */ (new Map());
  }

  /** @param {string} rootPath */
  async #detected(rootPath) {
    const key = canonicalPathKey(rootPath);
    if (!this.detectionCache.has(key)) {
      this.detectionCache.set(
        key,
        (async () => {
          try {
            const packageJson = JSON.parse(
              await fs.readFile(joinPath(rootPath, "package.json"), "utf8"),
            );
            const dependencies = {
              ...packageJson.dependencies,
              ...packageJson.devDependencies,
            };
            if (
              [
                "quasar",
                "quasar-framework",
                "@quasar/app",
                "@quasar/app-vite",
                "@quasar/app-webpack",
              ].some((name) => typeof dependencies[name] === "string")
            ) {
              return true;
            }
          } catch (error) {
            if (!(error instanceof SyntaxError) && !isMissingPathError(error)) {
              throw contextualFileSystemError(
                "Unable to inspect Quasar package metadata",
                joinPath(rootPath, "package.json"),
                error,
              );
            }
            // Detection is best effort and never changes normal resolver behavior.
          }
          return directoryExists(joinPath(rootPath, ".quasar"));
        })(),
      );
    }
    return this.detectionCache.get(key);
  }

  /** @param {ResolverContext | ImplicitResolverContext} context */
  async #enabled(context) {
    const mode = context.settings.presets?.quasar ?? "auto";
    if (mode === false || mode === "off") {
      return false;
    }
    return mode === true || mode === "on" || this.#detected(context.rootPath);
  }

  /** @param {ResolverContext} context */
  async candidateBases(context) {
    if (!(await this.#enabled(context))) {
      return [];
    }
    const { specifier, rootPath } = context;
    if (specifier === "variables") {
      return [
        { basePath: joinPath(rootPath, ".quasar", "variables.styl"), via: "quasar" },
        {
          basePath: joinPath(rootPath, "src", "css", "quasar.variables.styl"),
          via: "quasar",
        },
      ];
    }
    if (specifier === "quasar-app-variables") {
      return [
        {
          basePath: joinPath(rootPath, "src", "css", "themes", "variables.mat.styl"),
          via: "quasar",
        },
        {
          basePath: joinPath(rootPath, "src", "css", "themes", "variables.ios.styl"),
          via: "quasar",
        },
        {
          basePath: joinPath(rootPath, "src", "css", "quasar.variables.styl"),
          via: "quasar",
        },
      ];
    }
    for (const sourceAlias of ["components", "assets", "css"]) {
      if (specifier === sourceAlias || specifier.startsWith(`${sourceAlias}/`)) {
        const suffix = specifier.slice(sourceAlias.length).replace(/^\//, "");
        return [
          {
            basePath: joinPath(rootPath, "src", sourceAlias, suffix),
            via: "quasar-alias",
          },
        ];
      }
    }
    return [];
  }

  /** @param {ImplicitResolverContext} context */
  async implicitCandidateBases(context) {
    if (!(await this.#enabled(context))) {
      return [];
    }
    const relative = relativePath(context.rootPath, context.importerPath).replaceAll(
      "\\",
      "/",
    );
    if (
      relative.startsWith(".quasar/") ||
      relative.startsWith("node_modules/") ||
      /(?:^|\/)[^/]*variables[^/]*\.styl(?:us)?$/i.test(relative)
    ) {
      return [];
    }
    return [
      {
        basePath: joinPath(context.rootPath, ".quasar", "variables.styl"),
        via: "quasar-implicit",
      },
      {
        basePath: joinPath(context.rootPath, "src", "css", "quasar.variables.styl"),
        via: "quasar-implicit",
      },
    ];
  }

  clearCache() {
    this.detectionCache.clear();
  }
}

/**
 * Pure import resolver shared by navigation, completion, diagnostics, and the
 * import graph. It never parses or executes project configuration files.
 */
export class ImportResolver {
  /** @param {{rootPaths?: string[], presets?: ResolverPreset[]}} options */
  constructor({ rootPaths = [], presets = [new QuasarResolverPreset()] } = {}) {
    this.rootPaths = rootPaths.map(normalizeFilePath);
    this.presets = presets;
    this.settings = createWorkspaceSettings();
    this.workspaceSettings = /** @type {Map<string, ResolverWorkspaceSettings>} */ (
      new Map()
    );
    this.revision = 0;
    this.cache = /** @type {Map<string, Promise<ResolvedImport[]>>} */ (new Map());
  }

  /** @param {string[]} rootPaths */
  setRoots(rootPaths) {
    this.rootPaths = rootPaths.map(normalizeFilePath);
    this.revision += 1;
    this.clearCache();
  }

  /** @param {Record<string, unknown>} settings */
  configure(settings = {}) {
    this.settings = createWorkspaceSettings(settings);
    this.revision += 1;
    this.clearCache();
  }

  /** @param {string} rootPath @param {Record<string, unknown>} settings */
  configureWorkspace(rootPath, settings = {}) {
    const key = canonicalPathKey(rootPath);
    const previous = this.workspaceSettings.get(key);
    const override = createWorkspaceSettingsOverride(settings);
    this.workspaceSettings.set(key, {
      ...(previous ?? {}),
      ...override,
      rootPath: normalizeFilePath(rootPath),
      aliases: {
        ...(previous?.aliases ?? {}),
        ...(override.aliases ?? {}),
      },
      includePaths: [...(previous?.includePaths ?? []), ...(override.includePaths ?? [])],
      presets: { ...(previous?.presets ?? {}), ...(override.presets ?? {}) },
      themes: { ...(previous?.themes ?? {}), ...(override.themes ?? {}) },
      diagnostics: override.diagnostics
        ? {
            ...(previous?.diagnostics ?? {}),
            ...override.diagnostics,
            rules: {
              ...(previous?.diagnostics?.rules ?? {}),
              ...(override.diagnostics.rules ?? {}),
            },
          }
        : previous?.diagnostics,
    });
    this.revision += 1;
    this.clearCache();
  }

  clearWorkspaceConfigurations() {
    this.workspaceSettings.clear();
    this.revision += 1;
    this.clearCache();
  }

  /** @param {string} filePath @returns {string | null} */
  configurationRootFor(filePath) {
    return (
      [...this.workspaceSettings.values()]
        .filter((candidate) => isInside(candidate.rootPath, filePath))
        .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]?.rootPath ??
      null
    );
  }

  /** @param {string} filePath @returns {WorkspaceSettings} */
  settingsFor(filePath) {
    const workspace = [...this.workspaceSettings.values()]
      .filter((candidate) => isInside(candidate.rootPath, filePath))
      .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
    if (!workspace) {
      return this.settings;
    }
    return mergeWorkspaceSettings(this.settings, workspace);
  }

  clearCache() {
    this.cache.clear();
    for (const preset of this.presets) {
      preset.clearCache();
    }
  }

  /** @param {string} filePath @returns {string | null} */
  rootFor(filePath) {
    return (
      [...this.rootPaths]
        .sort((left, right) => right.length - left.length)
        .find((rootPath) => isInside(rootPath, filePath)) ??
      this.rootPaths[0] ??
      null
    );
  }

  /**
   * @param {string} specifier
   * @param {string} importer
   * @param {CancellationSignal | null} signal
   * @returns {Promise<ResolvedImport[]>}
   */
  async resolve(specifier, importer, signal = null) {
    const importerPath = importer.startsWith?.("file:")
      ? uriToFilePath(importer)
      : normalizeFilePath(importer);
    if (!importerPath || !specifier || /^(?:https?:|data:)/i.test(specifier)) {
      return [];
    }
    const normalizedSpecifier = normalizeSpecifier(specifier);
    if (
      GLOB_MAGIC.test(normalizedSpecifier) &&
      !isSafeGlobPattern(normalizedSpecifier, this.settings.maxBraceExpansions)
    ) {
      return [];
    }
    const cacheKey = `${this.revision}\0${canonicalPathKey(importerPath)}\0${normalizedSpecifier}`;
    if (!this.cache.has(cacheKey)) {
      const operation = this.#resolve(normalizedSpecifier, importerPath, signal);
      this.cache.set(cacheKey, operation);
      void operation.catch(() => {
        if (this.cache.get(cacheKey) === operation) {
          this.cache.delete(cacheKey);
        }
      });
    }
    return /** @type {Promise<ResolvedImport[]>} */ (this.cache.get(cacheKey));
  }

  /** Resolve framework-provided files that are injected into every Stylus unit. */
  /**
   * @param {string} importer
   * @param {CancellationSignal | null} signal
   * @returns {Promise<ResolvedImport[]>}
   */
  async resolveImplicit(importer, signal = null) {
    const importerPath = importer.startsWith?.("file:")
      ? uriToFilePath(importer)
      : normalizeFilePath(importer);
    if (!importerPath) {
      return [];
    }
    const cacheKey = `${this.revision}\0${canonicalPathKey(importerPath)}\0<implicit>`;
    if (!this.cache.has(cacheKey)) {
      const operation = this.#resolveImplicit(importerPath, signal);
      this.cache.set(cacheKey, operation);
      void operation.catch(() => {
        if (this.cache.get(cacheKey) === operation) {
          this.cache.delete(cacheKey);
        }
      });
    }
    return /** @type {Promise<ResolvedImport[]>} */ (this.cache.get(cacheKey));
  }

  /** Return real filesystem-backed candidates for an incomplete import path. */
  /**
   * @param {string} partialSpecifier
   * @param {string} importer
   * @param {CancellationSignal | null} signal
   * @returns {Promise<ImportCompletionResult>}
   */
  async complete(partialSpecifier, importer, signal = null) {
    const importerPath = importer.startsWith?.("file:")
      ? uriToFilePath(importer)
      : normalizeFilePath(importer);
    if (!importerPath) {
      return { items: [], isIncomplete: false };
    }
    const workspaceRoot = this.rootFor(importerPath) ?? dirname(importerPath);
    const rootPath = this.configurationRootFor(importerPath) ?? workspaceRoot;
    const settings = this.settingsFor(importerPath);
    const fromDirectory = dirname(importerPath);
    const normalized = partialSpecifier.replaceAll("\\", "/");
    const tilde = normalized.startsWith("~");
    const request = tilde ? normalized.slice(1) : normalized;
    const slash = request.lastIndexOf("/");
    const requestDirectory = slash === -1 ? "" : request.slice(0, slash + 1);
    const prefix = slash === -1 ? request : request.slice(slash + 1);
    /** @type {Array<
     *   {directory: string, labelPrefix: string, via: string, aliasOnly?: never} |
     *   {aliasOnly: string, via: string, directory?: never, labelPrefix?: never}
     * >} */
    const directories = [];
    /** @param {string} directory @param {string} labelPrefix @param {string} via */
    const addDirectory = (directory, labelPrefix, via) => {
      directories.push({ directory, labelPrefix, via });
    };

    if (request.startsWith("./") || request.startsWith("../")) {
      addDirectory(
        resolvePath(fromDirectory, requestDirectory || "."),
        `${tilde ? "~" : ""}${requestDirectory}`,
        "relative",
      );
    } else {
      for (const [alias, targets] of Object.entries(settings.aliases)) {
        const aliasName = alias.replace(/\$$/, "");
        if (slash === -1 && aliasName.startsWith(request)) {
          directories.push({ aliasOnly: aliasName, via: "alias" });
        }
        if (!aliasMatches(request, alias)) {
          continue;
        }
        const suffix = aliasSuffix(requestDirectory.replace(/\/$/, ""), alias);
        for (const target of Array.isArray(targets) ? targets : [targets]) {
          if (typeof target !== "string") {
            continue;
          }
          const targetPath =
            pathApi(target).isAbsolute(target) || isWindowsPath(target)
              ? target
              : resolvePath(rootPath, target);
          addDirectory(
            resolvePath(targetPath, suffix),
            `${tilde ? "~" : ""}${requestDirectory}`,
            "alias",
          );
        }
      }
      for (const includePath of settings.includePaths) {
        const includeRoot = pathApi(includePath).isAbsolute(includePath)
          ? includePath
          : resolvePath(rootPath, includePath);
        addDirectory(
          resolvePath(includeRoot, requestDirectory),
          `${tilde ? "~" : ""}${requestDirectory}`,
          "include-path",
        );
      }
      for (const ancestor of ancestorDirectories(importerPath, workspaceRoot)) {
        addDirectory(
          resolvePath(joinPath(ancestor, "node_modules"), requestDirectory),
          `${tilde ? "~" : ""}${requestDirectory}`,
          "node_modules",
        );
      }
      if (!tilde) {
        addDirectory(
          resolvePath(fromDirectory, requestDirectory),
          requestDirectory,
          "sibling",
        );
      }
    }

    const candidates = /** @type {Map<string, ImportCompletion>} */ (new Map());
    const resultLimit = settings.completionLimit;
    let entriesSeen = 0;
    let isIncomplete = false;
    /** @param {ImportCompletion} candidate */
    const addCandidate = (candidate) => {
      if (!candidates.has(candidate.label)) {
        candidates.set(candidate.label, candidate);
      }
      if (candidates.size > resultLimit) {
        isIncomplete = true;
      }
    };
    directoryLoop: for (const candidate of directories) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Import completion cancelled");
      }
      if ("aliasOnly" in candidate) {
        addCandidate({
          label: `${tilde ? "~" : ""}${candidate.aliasOnly}/`,
          kind: "module",
          via: candidate.via,
        });
        if (isIncomplete) break;
        continue;
      }
      try {
        const handle = await fs.opendir(candidate.directory);
        for await (const entry of handle) {
          if (signal?.aborted) {
            throw signal.reason ?? new Error("Import completion cancelled");
          }
          entriesSeen += 1;
          if (entriesSeen > settings.maxCompletionEntries) {
            isIncomplete = true;
            break directoryLoop;
          }
          if (!entry.name.toLowerCase().startsWith(prefix.toLowerCase())) {
            continue;
          }
          if (entry.isDirectory()) {
            addCandidate({
              label: `${candidate.labelPrefix}${entry.name}/`,
              kind: "folder",
              via: candidate.via,
            });
          } else if (
            entry.isFile() &&
            STYLUS_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          ) {
            addCandidate({
              label: `${candidate.labelPrefix}${entry.name}`,
              kind: "file",
              via: candidate.via,
            });
          }
          if (isIncomplete) {
            break directoryLoop;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isMissingPathError(error)) continue;
        throw contextualFileSystemError(
          "Unable to enumerate import completion directory",
          candidate.directory,
          error,
        );
      }
    }
    return {
      items: [...candidates.values()]
        .sort((left, right) => left.label.localeCompare(right.label))
        .slice(0, resultLimit),
      isIncomplete,
    };
  }

  /**
   * @param {string} specifier
   * @param {string} importerPath
   * @param {CancellationSignal | null} signal
   * @returns {Promise<ResolvedImport[]>}
   */
  async #resolve(specifier, importerPath, signal) {
    const workspaceRoot = this.rootFor(importerPath) ?? dirname(importerPath);
    const rootPath = this.configurationRootFor(importerPath) ?? workspaceRoot;
    const settings = this.settingsFor(importerPath);
    const fromDirectory = dirname(importerPath);
    const requestedPath = specifier.startsWith("file:") ? uriToFilePath(specifier) : null;
    const tildeRequest = specifier.startsWith("~");
    const importPath = tildeRequest ? specifier.slice(1) : specifier;
    const baseCandidates = /** @type {Array<{basePath: string, via: string}>} */ ([]);
    /** @param {string | null} basePath @param {string} via */
    const addBase = (basePath, via) => {
      if (basePath) {
        baseCandidates.push({ basePath, via });
      }
    };

    if (requestedPath) {
      if (settings.allowAbsolutePaths) {
        addBase(requestedPath, "file-uri");
      }
    } else if (pathApi(importPath).isAbsolute(importPath) || isWindowsPath(importPath)) {
      if (settings.allowAbsolutePaths) {
        addBase(normalizeFilePath(importPath), "absolute");
      }
    } else if (importPath.startsWith("./") || importPath.startsWith("../")) {
      addBase(resolvePath(fromDirectory, importPath), "relative");
    } else if (!tildeRequest) {
      addBase(resolvePath(fromDirectory, importPath), "sibling");
    }

    const aliases = Object.entries(settings.aliases).sort(
      ([left], [right]) => right.replace(/\$$/, "").length - left.replace(/\$$/, "").length,
    );
    for (const [alias, configuredTargets] of aliases) {
      if (!aliasMatches(importPath, alias)) {
        continue;
      }
      const suffix = aliasSuffix(importPath, alias);
      const targets = Array.isArray(configuredTargets)
        ? configuredTargets
        : [configuredTargets];
      for (const target of targets) {
        if (typeof target !== "string") {
          continue;
        }
        const base =
          pathApi(target).isAbsolute(target) || isWindowsPath(target)
            ? target
            : resolvePath(rootPath, target);
        addBase(resolvePath(base, suffix), "alias");
      }
    }

    for (const includePath of settings.includePaths) {
      const base =
        pathApi(includePath).isAbsolute(includePath) || isWindowsPath(includePath)
          ? includePath
          : resolvePath(rootPath, includePath);
      addBase(resolvePath(base, importPath), "include-path");
    }

    for (const preset of this.presets) {
      const candidates = await preset.candidateBases({
        specifier: importPath,
        importerPath,
        rootPath,
        settings,
      });
      for (const candidate of candidates) {
        addBase(candidate.basePath, candidate.via ?? preset.name);
      }
    }

    if (
      !requestedPath &&
      !pathApi(importPath).isAbsolute(importPath) &&
      !isWindowsPath(importPath) &&
      !importPath.startsWith("./") &&
      !importPath.startsWith("../")
    ) {
      for (const ancestor of ancestorDirectories(importerPath, workspaceRoot)) {
        addBase(joinPath(ancestor, "node_modules", importPath), "node_modules");
      }
    }

    const result = [];
    const seen = new Set();
    for (const candidate of baseCandidates) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Import resolution cancelled");
      }
      const paths = GLOB_MAGIC.test(candidate.basePath)
        ? await expandGlob(candidate.basePath, {
            maxMatches: settings.maxGlobMatches,
            maxDirectories: settings.maxGlobDirectories,
            maxEntries: settings.maxGlobEntries,
            maxDepth: settings.maxGlobDepth,
            maxBraceExpansions: settings.maxBraceExpansions,
            boundary:
              candidate.via === "relative" || candidate.via === "sibling"
                ? workspaceRoot
                : null,
            signal,
          })
        : candidate.via === "node_modules" && isPackageRootSpecifier(importPath)
          ? await packageSourceFileCandidates(candidate.basePath)
          : await sourceFileCandidates(candidate.basePath);
      for (const filePath of paths) {
        const key = canonicalPathKey(filePath);
        if (!seen.has(key)) {
          seen.add(key);
          result.push({
            filePath,
            uri: filePathToUri(filePath),
            via: candidate.via,
          });
        }
      }
    }
    return result;
  }

  /**
   * @param {string} importerPath
   * @param {CancellationSignal | null} signal
   * @returns {Promise<ResolvedImport[]>}
   */
  async #resolveImplicit(importerPath, signal) {
    const workspaceRoot = this.rootFor(importerPath) ?? dirname(importerPath);
    const rootPath = this.configurationRootFor(importerPath) ?? workspaceRoot;
    const settings = this.settingsFor(importerPath);
    for (const preset of this.presets) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Implicit import resolution cancelled");
      }
      const candidates = await preset.implicitCandidateBases({
        importerPath,
        rootPath,
        settings,
      });
      for (const candidate of candidates) {
        const paths = await sourceFileCandidates(candidate.basePath);
        if (paths.length) {
          return paths.map((filePath) => ({
            filePath,
            uri: filePathToUri(filePath),
            via: candidate.via ?? `${preset.name}-implicit`,
          }));
        }
      }
    }
    return [];
  }
}
