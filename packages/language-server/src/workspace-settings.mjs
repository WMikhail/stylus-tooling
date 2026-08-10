import { DEFAULT_MAX_BRACE_EXPANSIONS, isSafeGlobPattern } from "./glob-utils.mjs";

/**
 * @typedef {{
 *   enabled: boolean,
 *   debounceMs: number,
 *   rules: Record<string, unknown>
 * }} DiagnosticsSettings
 */

/**
 * @typedef {{
 *   aliases: Record<string, string | string[]>,
 *   includePaths: string[],
 *   exclude: string[],
 *   allowAbsolutePaths: boolean,
 *   maxFileSize: number,
 *   maxImportDepth: number,
 *   maxGlobMatches: number,
 *   maxGlobDirectories: number,
 *   maxGlobEntries: number,
 *   maxGlobDepth: number,
 *   maxBraceExpansions: number,
 *   maxWorkspaceDirectories: number,
 *   maxWorkspaceEntries: number,
 *   maxWorkspaceFiles: number,
 *   maxWorkspaceDepth: number,
 *   maxCompletionEntries: number,
 *   presets: {quasar: boolean | "on" | "off" | "auto"},
 *   themes: Record<string, string | string[]>,
 *   activeTheme: string | null,
 *   autoDetectAliases: boolean,
 *   completionLimit: number,
 *   diagnostics: DiagnosticsSettings
 * }} WorkspaceSettings
 */
/**
 * @typedef {Partial<Omit<WorkspaceSettings, "aliases" | "includePaths" | "exclude" | "presets" | "themes" | "diagnostics">> & {
 *   aliases?: Record<string, string | string[]>,
 *   includePaths?: string[],
 *   exclude?: string[],
 *   presets?: Partial<WorkspaceSettings["presets"]>,
 *   themes?: Record<string, string | string[]>,
 *   diagnostics?: Partial<DiagnosticsSettings> & {rules?: Record<string, unknown>}
 * }} WorkspaceSettingsOverride
 */

export const DEFAULT_EXCLUDES = Object.freeze([
  "**/.git/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/.yarn/**",
  "**/build/**",
  "**/coverage/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/vendor/**",
]);

const LIMITS = Object.freeze({
  maxFileSize: { default: 2 * 1024 * 1024, min: 1, max: 64 * 1024 * 1024 },
  maxImportDepth: { default: 64, min: 1, max: 256 },
  maxGlobMatches: { default: 10_000, min: 1, max: 10_000 },
  maxGlobDirectories: { default: 10_000, min: 1, max: 50_000 },
  maxGlobEntries: { default: 100_000, min: 1, max: 500_000 },
  maxGlobDepth: { default: 64, min: 1, max: 128 },
  maxBraceExpansions: {
    default: DEFAULT_MAX_BRACE_EXPANSIONS,
    min: 1,
    max: 1_024,
  },
  maxWorkspaceDirectories: { default: 10_000, min: 1, max: 100_000 },
  maxWorkspaceEntries: { default: 250_000, min: 1, max: 1_000_000 },
  maxWorkspaceFiles: { default: 100_000, min: 1, max: 500_000 },
  maxWorkspaceDepth: { default: 64, min: 1, max: 256 },
  maxCompletionEntries: { default: 10_000, min: 1, max: 100_000 },
  completionLimit: { default: 200, min: 1, max: 1_000 },
});

/**
 * @param {unknown} value
 * @param {{default: number, min: number, max: number}} limits
 */
function boundedInteger(value, { default: fallback, min, max }) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

/**
 * @param {unknown} value
 * @param {{default: number, min: number, max: number}} limits
 */
function optionalBoundedInteger(value, { min, max }) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value))
    : undefined;
}

/** @param {object} value @param {PropertyKey} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} value @param {number} maximum @returns {string[]} */
function stringArray(value, maximum = 1_000) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").slice(0, maximum)
    : [];
}

/** @param {unknown} value @returns {Record<string, string | string[]>} */
function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 1_000)
      .flatMap(([key, configured]) => {
        const values = Array.isArray(configured)
          ? stringArray(configured, 32)
          : [configured];
        const valid = values.filter((entry) => typeof entry === "string");
        if (!key || valid.length === 0) {
          return [];
        }
        return [[key, valid.length === 1 ? valid[0] : valid]];
      }),
  );
}

/** @param {unknown} value @returns {DiagnosticsSettings} */
function diagnosticsSettings(value) {
  const defaults = { enabled: true, debounceMs: 150, rules: {} };
  if (value === false) {
    return { ...defaults, enabled: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }
  const configured = /** @type {Record<string, unknown>} */ (value);
  return {
    enabled: configured.enabled !== false,
    debounceMs: boundedInteger(configured.debounceMs, {
      default: defaults.debounceMs,
      min: 0,
      max: 5_000,
    }),
    rules:
      configured.rules &&
      typeof configured.rules === "object" &&
      !Array.isArray(configured.rules)
        ? /** @type {Record<string, unknown>} */ (configured.rules)
        : {},
  };
}

/** @param {unknown} value @returns {WorkspaceSettingsOverride["diagnostics"]} */
function diagnosticsSettingsOverride(value) {
  if (value === false) {
    return { enabled: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const configured = /** @type {Record<string, unknown>} */ (value);
  const result = {};
  if (hasOwn(configured, "enabled") && typeof configured.enabled === "boolean") {
    result.enabled = configured.enabled;
  }
  if (hasOwn(configured, "debounceMs")) {
    const debounceMs = optionalBoundedInteger(configured.debounceMs, {
      default: 150,
      min: 0,
      max: 5_000,
    });
    if (debounceMs !== undefined) {
      result.debounceMs = debounceMs;
    }
  }
  if (
    configured.rules &&
    typeof configured.rules === "object" &&
    !Array.isArray(configured.rules)
  ) {
    result.rules = /** @type {Record<string, unknown>} */ (configured.rules);
  }
  return result;
}

/** @param {unknown} value */
function quasarPreset(value) {
  return value === true ||
    value === false ||
    value === "on" ||
    value === "off" ||
    value === "auto"
    ? value
    : undefined;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {WorkspaceSettings}
 */
export function createWorkspaceSettings(input = {}) {
  const exclude = stringArray(input.exclude).filter((pattern) =>
    isSafeGlobPattern(
      pattern,
      boundedInteger(input.maxBraceExpansions, LIMITS.maxBraceExpansions),
    ),
  );
  return {
    aliases: stringMap(input.aliases),
    includePaths: stringArray(input.includePaths),
    exclude: [...DEFAULT_EXCLUDES, ...exclude],
    allowAbsolutePaths: input.allowAbsolutePaths === true,
    maxFileSize: boundedInteger(input.maxFileSize, LIMITS.maxFileSize),
    maxImportDepth: boundedInteger(input.maxImportDepth, LIMITS.maxImportDepth),
    maxGlobMatches: boundedInteger(input.maxGlobMatches, LIMITS.maxGlobMatches),
    maxGlobDirectories: boundedInteger(input.maxGlobDirectories, LIMITS.maxGlobDirectories),
    maxGlobEntries: boundedInteger(input.maxGlobEntries, LIMITS.maxGlobEntries),
    maxGlobDepth: boundedInteger(input.maxGlobDepth, LIMITS.maxGlobDepth),
    maxBraceExpansions: boundedInteger(input.maxBraceExpansions, LIMITS.maxBraceExpansions),
    maxWorkspaceDirectories: boundedInteger(
      input.maxWorkspaceDirectories,
      LIMITS.maxWorkspaceDirectories,
    ),
    maxWorkspaceEntries: boundedInteger(
      input.maxWorkspaceEntries,
      LIMITS.maxWorkspaceEntries,
    ),
    maxWorkspaceFiles: boundedInteger(input.maxWorkspaceFiles, LIMITS.maxWorkspaceFiles),
    maxWorkspaceDepth: boundedInteger(input.maxWorkspaceDepth, LIMITS.maxWorkspaceDepth),
    maxCompletionEntries: boundedInteger(
      input.maxCompletionEntries,
      LIMITS.maxCompletionEntries,
    ),
    presets: {
      quasar:
        quasarPreset(
          objectRecord(input.presets)?.quasar ??
            objectRecord(input.resolverPresets)?.quasar,
        ) ?? "auto",
    },
    themes: stringMap(input.themes),
    activeTheme: typeof input.activeTheme === "string" ? input.activeTheme : null,
    autoDetectAliases: input.autoDetectAliases !== false,
    completionLimit: boundedInteger(input.completionLimit, LIMITS.completionLimit),
    diagnostics: diagnosticsSettings(input.diagnostics),
  };
}

/**
 * Normalize only explicitly supplied values so package-specific settings can
 * override global settings without injecting a second set of defaults.
 *
 * @param {Record<string, unknown>} input
 * @returns {WorkspaceSettingsOverride}
 */
export function createWorkspaceSettingsOverride(input = {}) {
  const result = /** @type {WorkspaceSettingsOverride} */ ({});
  if (hasOwn(input, "aliases")) result.aliases = stringMap(input.aliases);
  if (hasOwn(input, "includePaths")) {
    result.includePaths = stringArray(input.includePaths);
  }
  if (hasOwn(input, "exclude")) {
    const maxBraceExpansions =
      optionalBoundedInteger(input.maxBraceExpansions, LIMITS.maxBraceExpansions) ??
      DEFAULT_MAX_BRACE_EXPANSIONS;
    result.exclude = stringArray(input.exclude).filter((pattern) =>
      isSafeGlobPattern(pattern, maxBraceExpansions),
    );
  }
  if (typeof input.allowAbsolutePaths === "boolean") {
    result.allowAbsolutePaths = input.allowAbsolutePaths;
  }
  for (const key of /** @type {Array<keyof typeof LIMITS>} */ (Object.keys(LIMITS))) {
    if (!hasOwn(input, key)) continue;
    const value = optionalBoundedInteger(input[key], LIMITS[key]);
    if (value !== undefined) {
      /** @type {Record<string, unknown>} */ (result)[key] = value;
    }
  }
  const preset = quasarPreset(
    objectRecord(input.presets)?.quasar ?? objectRecord(input.resolverPresets)?.quasar,
  );
  if (preset !== undefined) result.presets = { quasar: preset };
  if (hasOwn(input, "themes")) result.themes = stringMap(input.themes);
  if (typeof input.activeTheme === "string" || input.activeTheme === null) {
    result.activeTheme = input.activeTheme;
  }
  if (typeof input.autoDetectAliases === "boolean") {
    result.autoDetectAliases = input.autoDetectAliases;
  }
  if (hasOwn(input, "diagnostics")) {
    const diagnostics = diagnosticsSettingsOverride(input.diagnostics);
    if (diagnostics) result.diagnostics = diagnostics;
  }
  return result;
}

/**
 * @param {WorkspaceSettings} base
 * @param {WorkspaceSettingsOverride | undefined} override
 * @returns {WorkspaceSettings}
 */
export function mergeWorkspaceSettings(base, override) {
  if (!override) return base;
  return {
    ...base,
    ...override,
    aliases: { ...base.aliases, ...(override.aliases ?? {}) },
    includePaths: override.includePaths
      ? [...override.includePaths, ...base.includePaths]
      : base.includePaths,
    exclude: override.exclude
      ? [...new Set([...base.exclude, ...override.exclude])]
      : base.exclude,
    presets: { ...base.presets, ...(override.presets ?? {}) },
    themes: { ...base.themes, ...(override.themes ?? {}) },
    diagnostics: override.diagnostics
      ? {
          ...base.diagnostics,
          ...override.diagnostics,
          rules: {
            ...base.diagnostics.rules,
            ...(override.diagnostics.rules ?? {}),
          },
        }
      : base.diagnostics,
  };
}

/**
 * @param {unknown} settings
 * @returns {{
 *   settings: WorkspaceSettings,
 *   workspaceOverrides: Record<string, Record<string, unknown>>,
 * }}
 */
export function normalizeWorkspaceConfiguration(settings = {}) {
  const configured = objectRecord(settings) ?? {};
  const input = objectRecord(configured.stylus) ?? configured;
  const workspaces = objectRecord(input.workspaces);
  return {
    settings: createWorkspaceSettings(input),
    workspaceOverrides:
      workspaces === null
        ? {}
        : Object.fromEntries(
            Object.entries(workspaces).flatMap(([key, value]) => {
              const workspace = objectRecord(value);
              return workspace ? [[key, workspace]] : [];
            }),
          ),
  };
}
