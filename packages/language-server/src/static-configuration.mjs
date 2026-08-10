import { promises as fs } from "node:fs";
import path from "node:path";

import { contextualFileSystemError, isMissingPathError } from "./filesystem-errors.mjs";
import { safeMinimatch } from "./glob-utils.mjs";
import { readRootIgnore } from "./workspace-scanner.mjs";
import { createWorkspaceSettings } from "./workspace-settings.mjs";

/** @type {typeof import("typescript") | null} */
let typescriptModule = null;

async function loadTypeScript() {
  typescriptModule ??= (await import("typescript")).default;
  return typescriptModule;
}

function loadedTypeScript() {
  if (!typescriptModule) {
    throw new Error("TypeScript must be loaded before parsing project configuration");
  }
  return typescriptModule;
}

const CONFIG_FILES = ["vite", "webpack", "nuxt"].flatMap((name) =>
  ["js", "mjs", "cjs", "ts", "mts", "cts"].map(
    (extension) => `${name}.config.${extension}`,
  ),
);
const CONFIGURATION_MAX_DEPTH = 5;

/** @typedef {string | number | boolean | null | unknown[] | Record<string, unknown>} StaticValue */
/** @typedef {{ directory: string, variables: Map<string, StaticValue> }} EvaluationContext */
/** @typedef {Record<string, string | string[]>} AliasMap */
/**
 * @typedef {{
 *   rootPath: string,
 *   aliases: AliasMap,
 *   includePaths: string[],
 * }} DiscoveredConfiguration
 */

/** @param {import("typescript").PropertyName} node @returns {string | null} */
function propertyName(node) {
  const ts = loadedTypeScript();
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

/** @param {import("typescript").CallExpression} node @returns {"resolve" | "join" | null} */
function pathCallName(node) {
  const ts = loadedTypeScript();
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "resolve" || node.expression.text === "join"
      ? node.expression.text
      : null;
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "path" &&
    (node.expression.name.text === "resolve" || node.expression.name.text === "join")
  ) {
    return node.expression.name.text;
  }
  return null;
}

/**
 * @param {import("typescript").Expression | undefined} node
 * @param {EvaluationContext} context
 * @returns {StaticValue | undefined}
 */
function evaluateStatic(node, context) {
  const ts = loadedTypeScript();
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) {
    if (node.text === "__dirname") return context.directory;
    return context.variables.get(node.text);
  }
  if (ts.isParenthesizedExpression(node)) return evaluateStatic(node.expression, context);
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return evaluateStatic(node.expression, context);
  }
  if (ts.isArrayLiteralExpression(node)) {
    /** @type {StaticValue[]} */
    const result = [];
    for (const element of node.elements) {
      const value = evaluateStatic(element, context);
      if (value === undefined) return undefined;
      result.push(value);
    }
    return result;
  }
  if (ts.isObjectLiteralExpression(node)) {
    /** @type {Record<string, StaticValue>} */
    const result = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const value = evaluateStatic(property.expression, context);
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        Object.assign(result, value);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = context.variables.get(property.name.text);
        if (value === undefined) return undefined;
        result[property.name.text] = value;
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = propertyName(property.name);
      const value = evaluateStatic(property.initializer, context);
      if (name === null || value === undefined) return undefined;
      result[name] = value;
    }
    return result;
  }
  if (ts.isCallExpression(node)) {
    if (
      ts.isIdentifier(node.expression) &&
      ["defineConfig", "defineNuxtConfig"].includes(node.expression.text) &&
      node.arguments.length === 1
    ) {
      return evaluateStatic(node.arguments[0], context);
    }
    const pathMethod = pathCallName(node);
    if (pathMethod) {
      /** @type {(StaticValue | undefined)[]} */
      const values = node.arguments.map((argument) => evaluateStatic(argument, context));
      if (values.every((value) => typeof value === "string")) {
        const pathValues = /** @type {string[]} */ (values);
        return pathMethod === "join"
          ? path.join(...pathValues)
          : path.resolve(context.directory, ...pathValues);
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * @param {import("typescript").SourceFile} sourceFile
 * @param {EvaluationContext} context
 * @returns {StaticValue | undefined}
 */
function exportedConfiguration(sourceFile, context) {
  const ts = loadedTypeScript();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const value = evaluateStatic(declaration.initializer, context);
        if (value !== undefined) context.variables.set(declaration.name.text, value);
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      return evaluateStatic(statement.expression, context);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sourceFile) === "module.exports"
    ) {
      return evaluateStatic(statement.expression.right, context);
    }
  }
  return undefined;
}

/**
 * @param {AliasMap} output
 * @param {unknown} name
 * @param {unknown} value
 * @param {string} directory
 */
function addAlias(output, name, value, directory) {
  if (typeof name !== "string" || typeof value !== "string") return;
  const normalized = path.isAbsolute(value) ? value : path.resolve(directory, value);
  const previous = output[name];
  if (!previous) output[name] = normalized;
  else if (Array.isArray(previous)) previous.push(normalized);
  else output[name] = [previous, normalized];
}

/**
 * @param {unknown} value
 * @param {string} directory
 * @param {AliasMap} output
 */
function collectAliases(value, directory, output) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object") {
        const alias = /** @type {Record<string, unknown>} */ (entry);
        addAlias(output, alias.find, alias.replacement, directory);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [name, target] of Object.entries(value)) {
    if (typeof target === "string") addAlias(output, name, target, directory);
  }
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function objectValue(value, key) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}

/**
 * @param {StaticValue} config
 * @param {string} directory
 * @param {string} fileName
 * @returns {AliasMap}
 */
function aliasesFromConfig(config, directory, fileName) {
  /** @type {AliasMap} */
  const aliases = {};
  const baseName = path.basename(fileName);
  collectAliases(objectValue(objectValue(config, "resolve"), "alias"), directory, aliases);
  if (baseName.startsWith("nuxt.config")) {
    collectAliases(objectValue(config, "alias"), directory, aliases);
    collectAliases(
      objectValue(objectValue(objectValue(config, "vite"), "resolve"), "alias"),
      directory,
      aliases,
    );
    const configuredSourceDirectory = objectValue(config, "srcDir");
    const sourceDirectory =
      typeof configuredSourceDirectory === "string"
        ? path.resolve(directory, configuredSourceDirectory)
        : directory;
    addAlias(aliases, "@", sourceDirectory, directory);
    addAlias(aliases, "~", sourceDirectory, directory);
    addAlias(aliases, "@@", directory, directory);
    addAlias(aliases, "~~", directory, directory);
  }
  return aliases;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ aliases: AliasMap, message: string | null }>}
 */
async function parseScriptConfiguration(filePath) {
  const ts = await loadTypeScript();
  const text = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:[cm]?ts)$/i.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const parseErrors =
    /** @type {import("typescript").SourceFile & {
     *   parseDiagnostics?: readonly import("typescript").Diagnostic[]
     * }} */ (sourceFile).parseDiagnostics ?? [];
  if (parseErrors.length) {
    return {
      aliases: {},
      message: `${filePath}: configuration has syntax errors and was not loaded.`,
    };
  }
  /** @type {EvaluationContext} */
  const context = { directory: path.dirname(filePath), variables: new Map() };
  const config = exportedConfiguration(sourceFile, context);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      aliases: {},
      message: `${filePath}: configuration is dynamic; use explicit stylus.aliases settings.`,
    };
  }
  return { aliases: aliasesFromConfig(config, context.directory, filePath), message: null };
}

/**
 * @param {string} filePath
 * @returns {Promise<{ aliases: AliasMap, includePaths: string[] }>}
 */
async function parseTsConfig(filePath) {
  const ts = await loadTypeScript();
  const text = await fs.readFile(filePath, "utf8");
  const parsed = ts.parseConfigFileTextToJson(filePath, text);
  if (parsed.error || !parsed.config) {
    return { aliases: {}, includePaths: [] };
  }
  const rawConfig = /** @type {Record<string, unknown>} */ (parsed.config);
  const compilerOptions = /** @type {Record<string, unknown>} */ (
    objectValue(rawConfig, "compilerOptions") ?? {}
  );
  const directory = path.dirname(filePath);
  const baseUrlSetting = compilerOptions.baseUrl;
  const baseUrl = path.resolve(
    directory,
    typeof baseUrlSetting === "string" ? baseUrlSetting : ".",
  );
  /** @type {AliasMap} */
  const aliases = {};
  const configuredPaths = objectValue(compilerOptions, "paths");
  const paths =
    configuredPaths &&
    typeof configuredPaths === "object" &&
    !Array.isArray(configuredPaths)
      ? /** @type {Record<string, unknown>} */ (configuredPaths)
      : {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const alias = pattern.replace(/\/\*$/, "");
    const resolved = targets
      .filter((target) => typeof target === "string")
      .map((target) => path.resolve(baseUrl, target.replace(/\/\*$/, "")));
    if (resolved.length) aliases[alias] = resolved.length === 1 ? resolved[0] : resolved;
  }
  return { aliases, includePaths: typeof baseUrlSetting === "string" ? [baseUrl] : [] };
}

/**
 * @param {string} rootPath
 * @param {import("./workspace-settings.mjs").WorkspaceSettings} settings
 * @param {{readonly aborted: boolean, readonly reason?: unknown} | null} signal
 */
async function configurationDirectories(rootPath, settings, signal) {
  const result = new Set([rootPath]);
  const ignoreResult = await readRootIgnore(rootPath);
  const ignored = ignoreResult.matcher;
  const messages = [...ignoreResult.messages];
  const queue = [{ directory: rootPath, depth: 0 }];
  let cursor = 0;
  let directories = 0;
  let entriesSeen = 0;
  let truncated = false;
  let limitMessage = null;
  const maxDepth = Math.min(CONFIGURATION_MAX_DEPTH, settings.maxWorkspaceDepth);
  while (cursor < queue.length) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Workspace configuration discovery cancelled");
    }
    const { directory, depth } = queue[cursor++];
    directories += 1;
    if (directories > settings.maxWorkspaceDirectories) {
      truncated = true;
      limitMessage = `Configuration discovery stopped after ${settings.maxWorkspaceDirectories} directories.`;
      break;
    }
    if (depth >= maxDepth) continue;
    const entries = [];
    try {
      const handle = await fs.opendir(directory);
      for await (const entry of handle) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Workspace configuration discovery cancelled");
        }
        entriesSeen += 1;
        if (entriesSeen > settings.maxWorkspaceEntries) {
          truncated = true;
          limitMessage = `Configuration discovery stopped after ${settings.maxWorkspaceEntries} filesystem entries.`;
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isMissingPathError(error)) continue;
      throw contextualFileSystemError(
        "Unable to enumerate configuration directory",
        directory,
        error,
      );
    }
    if (truncated) break;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      result.add(directory);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(rootPath, entryPath).replaceAll(path.sep, "/");
      const matchPath = `${relative}/`;
      const excluded = settings.exclude.some((pattern) =>
        safeMinimatch(matchPath, pattern, {
          maxBraceExpansions: settings.maxBraceExpansions,
        }),
      );
      if (!excluded && !ignored.ignores(matchPath)) {
        queue.push({ directory: entryPath, depth: depth + 1 });
      }
    }
  }
  if (limitMessage) {
    messages.push(`${limitMessage} Narrow the workspace or adjust Stylus scan limits.`);
  }
  return {
    directories: [...result].sort((left, right) => left.localeCompare(right)),
    messages,
    truncated,
  };
}

/**
 * Discover aliases without importing or executing any project configuration.
 *
 * @param {string} rootPath
 * @param {import("./workspace-settings.mjs").WorkspaceSettings} [settings]
 * @param {{readonly aborted: boolean, readonly reason?: unknown} | null} [signal]
 * @returns {Promise<{
 *   configurations: DiscoveredConfiguration[],
 *   messages: string[],
 * }>}
 */
export async function discoverWorkspaceConfigurations(
  rootPath,
  settings = createWorkspaceSettings(),
  signal = null,
) {
  /** @type {DiscoveredConfiguration[]} */
  const configurations = [];
  /** @type {string[]} */
  const messages = [];
  const discovery = await configurationDirectories(rootPath, settings, signal);
  messages.push(...discovery.messages);
  for (const directory of discovery.directories) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Workspace configuration discovery cancelled");
    }
    /** @type {AliasMap} */
    const aliases = {};
    /** @type {string[]} */
    const includePaths = [];
    for (const fileName of CONFIG_FILES) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Workspace configuration discovery cancelled");
      }
      const filePath = path.join(directory, fileName);
      try {
        await fs.access(filePath);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw contextualFileSystemError(
          "Unable to inspect workspace configuration",
          filePath,
          error,
        );
      }
      const parsed = await parseScriptConfiguration(filePath);
      Object.assign(aliases, parsed.aliases);
      if (parsed.message) messages.push(parsed.message);
    }
    for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Workspace configuration discovery cancelled");
      }
      const filePath = path.join(directory, fileName);
      try {
        await fs.access(filePath);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw contextualFileSystemError(
          "Unable to inspect TypeScript configuration",
          filePath,
          error,
        );
      }
      const parsed = await parseTsConfig(filePath);
      Object.assign(aliases, parsed.aliases);
      includePaths.push(...parsed.includePaths);
    }
    // Keep package roots even when they contribute no static aliases. Resolver
    // presets use the nearest package boundary for framework detection.
    configurations.push({ rootPath: directory, aliases, includePaths });
  }
  return { configurations, messages };
}
