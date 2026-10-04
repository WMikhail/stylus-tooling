import { isKnownCssFunction, isKnownCssIdentifier } from "./authoring.mjs";

/** @typedef {import("vscode-languageserver").Diagnostic} Diagnostic */
/** @typedef {import("vscode-languageserver").DiagnosticRelatedInformation} DiagnosticRelatedInformation */
/** @typedef {import("vscode-languageserver").Range} Range */
/** @typedef {import("./semantic-model.mjs").SemanticModel} SemanticModel */
/** @typedef {import("./semantic-model.mjs").SemanticSymbol} SemanticSymbol */
/** @typedef {import("./semantic-model.mjs").SemanticReference} SemanticReference */
/** @typedef {import("./workspace-settings.mjs").WorkspaceSettings} WorkspaceSettings */
/**
 * @typedef {{
 *   text: string,
 *   models: SemanticModel[],
 *   embeddedErrors: unknown[],
 * }} DiagnosticDocument
 */

export const DIAGNOSTIC_CODES = Object.freeze({
  syntaxError: "stylus.syntax-error",
  vueParseError: "stylus.vue-parse-error",
  unresolvedImport: "stylus.unresolved-import",
  unknownVariable: "stylus.unknown-variable",
  unknownFunction: "stylus.unknown-function",
  unknownMixin: "stylus.unknown-mixin",
  unknownKeyframes: "stylus.unknown-keyframes",
  cyclicImport: "stylus.cyclic-import",
  conflictingDefinition: "stylus.conflicting-definition",
  unusedLocalVariable: "stylus.unused-local-variable",
});

/** @type {Record<string, number>} */
const DEFAULT_SEVERITIES = {
  [DIAGNOSTIC_CODES.syntaxError]: 1,
  [DIAGNOSTIC_CODES.vueParseError]: 1,
  [DIAGNOSTIC_CODES.unresolvedImport]: 1,
  [DIAGNOSTIC_CODES.unknownVariable]: 2,
  [DIAGNOSTIC_CODES.unknownFunction]: 2,
  [DIAGNOSTIC_CODES.unknownMixin]: 2,
  [DIAGNOSTIC_CODES.unknownKeyframes]: 2,
  [DIAGNOSTIC_CODES.cyclicImport]: 2,
  [DIAGNOSTIC_CODES.conflictingDefinition]: 2,
  [DIAGNOSTIC_CODES.unusedLocalVariable]: 4,
};

/** @type {Record<string, number>} */
const SEVERITY_NAMES = {
  error: 1,
  warning: 2,
  information: 3,
  info: 3,
  hint: 4,
};

const STYLUS_BUILTIN_FUNCTIONS = new Set([
  "-math-prop",
  "-prefix-classes",
  "-string",
  "abs",
  "acos",
  "add-property",
  "adjust",
  "alpha",
  "append",
  "asin",
  "atan",
  "atan2",
  "avg",
  "basename",
  "base-convert",
  "blend",
  "blue",
  "cache",
  "ceil",
  "channel",
  "clone",
  "complement",
  "component",
  "contrast",
  "convert",
  "cos",
  "current-media",
  "dark",
  "darken",
  "degrees-to-radians",
  "define",
  "desaturate",
  "dirname",
  "error",
  "even",
  "extend",
  "extname",
  "fade-in",
  "fade-out",
  "floor",
  "grayscale",
  "green",
  "hsl",
  "hsla",
  "hue",
  "image-size",
  "index",
  "invert",
  "join",
  "json",
  "keys",
  "last",
  "length",
  "light",
  "lighten",
  "lightness",
  "list-separator",
  "lookup",
  "luminosity",
  "match",
  "math",
  "max",
  "merge",
  "min",
  "mix",
  "odd",
  "operate",
  "opposite-position",
  "p",
  "pathjoin",
  "percent-to-decimal",
  "percentage",
  "pop",
  "prefix-classes",
  "prepend",
  "push",
  "radians-to-degrees",
  "range",
  "red",
  "remove",
  "remove-unit",
  "replace",
  "require-color",
  "require-string",
  "require-unit",
  "rgb",
  "rgba",
  "round",
  "s",
  "saturate",
  "saturation",
  "selector",
  "selector-exists",
  "selectors",
  "shade",
  "shift",
  "sin",
  "slice",
  "spin",
  "split",
  "sprintf",
  "sqrt",
  "substr",
  "sum",
  "tan",
  "tint",
  "trace",
  "transparentify",
  "type",
  "type-of",
  "typeof",
  "unit",
  "unquote",
  "unshift",
  "url",
  "use",
  "values",
  "warn",
]);

/** @param {WorkspaceSettings} settings @param {string} code @returns {number | null} */
function severityFor(settings, code) {
  const diagnostics = settings.diagnostics ?? {};
  if (diagnostics.enabled === false) {
    return null;
  }
  const shortCode = code
    .replace(/^stylus\./, "")
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const configured = diagnostics.rules?.[code] ?? diagnostics.rules?.[shortCode];
  const configuredRule =
    configured && typeof configured === "object" && !Array.isArray(configured)
      ? /** @type {Record<string, unknown>} */ (configured)
      : null;
  if (configured === false || configured === "off" || configuredRule?.enabled === false) {
    return null;
  }
  const severity = configuredRule ? configuredRule.severity : configured;
  if (typeof severity === "number" && severity >= 1 && severity <= 4) {
    return severity;
  }
  if (typeof severity === "string" && SEVERITY_NAMES[severity.toLowerCase()]) {
    return SEVERITY_NAMES[severity.toLowerCase()];
  }
  return DEFAULT_SEVERITIES[code] ?? 2;
}

/**
 * @param {WorkspaceSettings} settings
 * @param {string} code
 * @param {string} message
 * @param {Range} range
 * @param {DiagnosticRelatedInformation[] | undefined} relatedInformation
 * @returns {Diagnostic | null}
 */
function createDiagnostic(settings, code, message, range, relatedInformation = undefined) {
  const severity = severityFor(settings, code);
  if (severity === null) {
    return null;
  }
  return {
    range,
    severity: /** @type {import("vscode-languageserver").DiagnosticSeverity} */ (severity),
    code,
    source: "stylus",
    message,
    relatedInformation,
  };
}

/**
 * @param {DiagnosticDocument} document
 * @param {unknown} error
 * @returns {Range}
 */
function compilerErrorRange(document, error) {
  const structured =
    /** @type {{
     *   loc?: {start?: {offset?: unknown}}
     * }} */ (error);
  const offset = structured?.loc?.start?.offset;
  if (typeof offset === "number") {
    const model = document.models.find((candidate) =>
      candidate.embedded.containsHostOffset(offset, true),
    );
    if (model) {
      return model.embedded.hostLines.range(
        offset,
        Math.min(offset + 1, document.text.length),
      );
    }
  }
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
}

/** @param {SemanticModel} model @returns {SemanticSymbol[][]} */
function conflictGroups(model) {
  /** @type {Map<string, SemanticSymbol[]>} */
  const groups = new Map();
  for (const symbol of model.symbols) {
    if (
      !["function", "mixin", "keyframes", "parameter", "loop-variable"].includes(
        symbol.kind,
      )
    ) {
      continue;
    }
    const prefix =
      symbol.kind === "keyframes"
        ? (model.embedded.text
            .slice(symbol.localFullStart, symbol.localNameStart)
            .match(/^@-(?:webkit|moz|o|ms)-/)?.[0] ?? "")
        : "";
    const key = `${symbol.scopeId}:${symbol.name}:${prefix}`;
    const values = groups.get(key) ?? [];
    values.push(symbol);
    groups.set(key, values);
  }
  return [...groups.values()].filter((symbols) => symbols.length > 1);
}

/** @param {SemanticReference} reference @returns {string | null} */
function unknownCode(reference) {
  if (reference.expectedKinds.includes("function")) {
    return DIAGNOSTIC_CODES.unknownFunction;
  }
  if (reference.expectedKinds.includes("mixin")) {
    return DIAGNOSTIC_CODES.unknownMixin;
  }
  if (reference.expectedKinds.includes("keyframes")) {
    return DIAGNOSTIC_CODES.unknownKeyframes;
  }
  if (
    reference.expectedKinds.includes("selector") ||
    reference.expectedKinds.includes("placeholder")
  ) {
    return null;
  }
  return DIAGNOSTIC_CODES.unknownVariable;
}

/** @param {SemanticReference} reference @param {string} code @returns {string} */
function unknownMessage(reference, code) {
  if (code === DIAGNOSTIC_CODES.unknownFunction)
    return `Unknown function '${reference.name}'.`;
  if (code === DIAGNOSTIC_CODES.unknownMixin) return `Unknown mixin '${reference.name}'.`;
  if (code === DIAGNOSTIC_CODES.unknownKeyframes)
    return `Unknown keyframes '${reference.name}'.`;
  return `Unknown variable '${reference.name}'.`;
}

/** @param {SemanticReference} reference @param {string} code @returns {boolean} */
function shouldSuppressUnknown(reference, code) {
  if (
    (code === DIAGNOSTIC_CODES.unknownFunction || code === DIAGNOSTIC_CODES.unknownMixin) &&
    (STYLUS_BUILTIN_FUNCTIONS.has(reference.name.toLowerCase()) ||
      isKnownCssFunction(reference.name))
  ) {
    return true;
  }
  return (
    code === DIAGNOSTIC_CODES.unknownVariable &&
    !reference.name.startsWith("$") &&
    (reference.role === "css-counter-identifier" ||
      isKnownCssIdentifier(reference.name) ||
      (reference.expectedKinds.includes("callable") &&
        STYLUS_BUILTIN_FUNCTIONS.has(reference.name.toLowerCase())))
  );
}

/**
 * Build deterministic semantic diagnostics after the workspace has resolved
 * references and import cycles for this host document.
 *
 * @param {{
 *   document: DiagnosticDocument,
 *   settings: WorkspaceSettings,
 *   cyclicImportIds?: Set<string>,
 *   resolvedSymbolIdsByReference?: Map<string, string[]> | null,
 * }} options
 * @returns {Diagnostic[]}
 */
export function collectDiagnostics({
  document,
  settings,
  cyclicImportIds = new Set(),
  resolvedSymbolIdsByReference = /** @type {Map<string, string[]> | null} */ (null),
}) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @param {SemanticReference} reference @returns {string[]} */
  const resolvedIds = (reference) =>
    resolvedSymbolIdsByReference?.get(reference.id) ?? reference.resolvedSymbolIds ?? [];
  /** @param {Diagnostic | null} diagnostic */
  const add = (diagnostic) => {
    if (diagnostic) diagnostics.push(diagnostic);
  };

  for (const error of document.embeddedErrors ?? []) {
    const message =
      typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : "";
    add(
      createDiagnostic(
        settings,
        DIAGNOSTIC_CODES.vueParseError,
        message || "Unable to parse component document.",
        compilerErrorRange(document, error),
      ),
    );
  }

  for (const model of document.models) {
    for (const error of model.syntaxErrors) {
      add(
        createDiagnostic(
          settings,
          DIAGNOSTIC_CODES.syntaxError,
          error.message,
          error.range,
        ),
      );
    }
    for (const imported of model.imports) {
      if (!imported.resolvedUris.length) {
        add(
          createDiagnostic(
            settings,
            DIAGNOSTIC_CODES.unresolvedImport,
            `Unable to resolve import '${imported.specifier}'.`,
            imported.nameRange,
          ),
        );
      }
      if (cyclicImportIds.has(imported.id)) {
        add(
          createDiagnostic(
            settings,
            DIAGNOSTIC_CODES.cyclicImport,
            `Import '${imported.specifier}' participates in a cycle.`,
            imported.nameRange,
          ),
        );
      }
    }
    for (const reference of model.references) {
      if (resolvedIds(reference).length) {
        continue;
      }
      const code = unknownCode(reference);
      if (code && !shouldSuppressUnknown(reference, code)) {
        add(
          createDiagnostic(
            settings,
            code,
            unknownMessage(reference, code),
            reference.range,
          ),
        );
      }
    }
    for (const symbols of conflictGroups(model)) {
      for (const symbol of symbols.slice(1)) {
        add(
          createDiagnostic(
            settings,
            DIAGNOSTIC_CODES.conflictingDefinition,
            `Conflicting ${symbol.kind} definition '${symbol.name}'.`,
            symbol.nameRange,
            [
              {
                location: { uri: symbols[0].uri, range: symbols[0].nameRange },
                message: "First definition is here.",
              },
            ],
          ),
        );
      }
    }
    for (const symbol of model.symbols) {
      if (
        symbol.kind !== "variable" ||
        model.scopeById.get(symbol.scopeId)?.type === "file"
      ) {
        continue;
      }
      const used = model.references.some((reference) =>
        resolvedIds(reference).includes(symbol.id),
      );
      if (!used) {
        add(
          createDiagnostic(
            settings,
            DIAGNOSTIC_CODES.unusedLocalVariable,
            `Local variable '${symbol.name}' is never used.`,
            symbol.nameRange,
          ),
        );
      }
    }
  }

  /** @type {Map<string, Diagnostic>} */
  const unique = new Map();
  for (const diagnostic of diagnostics) {
    const { start, end } = diagnostic.range;
    unique.set(
      `${diagnostic.code}:${start.line}:${start.character}:${end.line}:${end.character}:${diagnostic.message}`,
      diagnostic,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.range.start.line - right.range.start.line ||
      left.range.start.character - right.range.start.character ||
      String(left.code).localeCompare(String(right.code)),
  );
}
