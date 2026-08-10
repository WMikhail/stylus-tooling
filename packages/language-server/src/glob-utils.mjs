import { minimatch } from "minimatch";

export const MAX_GLOB_PATTERN_LENGTH = 4_096;
export const DEFAULT_MAX_BRACE_EXPANSIONS = 256;

/** @param {string} value @returns {number | null} */
function rangeCardinality(value) {
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(value);
  if (!match) {
    return null;
  }
  const startNumeric = /^-?\d+$/.test(match[1]);
  const endNumeric = /^-?\d+$/.test(match[2]);
  if (startNumeric !== endNumeric) {
    return Number.POSITIVE_INFINITY;
  }
  const numeric = startNumeric && endNumeric;
  const start = numeric ? Number(match[1]) : match[1].charCodeAt(0);
  const end = numeric ? Number(match[2]) : match[2].charCodeAt(0);
  const step = match[3] === undefined ? 1 : Math.abs(Number(match[3]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || step < 1) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(Math.abs(end - start) / step) + 1;
}

/** @param {string} value @returns {number} */
function alternativeCardinality(value) {
  const range = rangeCardinality(value);
  if (range !== null) {
    return range;
  }
  let alternatives = 1;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ",") {
      alternatives += 1;
    }
  }
  return alternatives;
}

/**
 * Reject patterns that can make minimatch allocate an excessive brace expansion.
 * Nested braces are intentionally unsupported: ordinary Stylus import globs only
 * need simple alternatives such as `*.{styl,stylus}`.
 * @param {string} pattern
 * @param {number} maxBraceExpansions
 * @returns {boolean}
 */
export function isSafeGlobPattern(
  pattern,
  maxBraceExpansions = DEFAULT_MAX_BRACE_EXPANSIONS,
) {
  if (
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    pattern.length > MAX_GLOB_PATTERN_LENGTH
  ) {
    return false;
  }
  let braceStart = -1;
  let expansionCount = 1;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "{") {
      if (braceStart !== -1) {
        return false;
      }
      braceStart = index;
    } else if (character === "}") {
      if (braceStart === -1) {
        return false;
      }
      expansionCount *= alternativeCardinality(pattern.slice(braceStart + 1, index));
      if (!Number.isSafeInteger(expansionCount) || expansionCount > maxBraceExpansions) {
        return false;
      }
      braceStart = -1;
    }
  }
  return braceStart === -1;
}

/**
 * @param {string} value
 * @param {string} pattern
 * @param {{maxBraceExpansions?: number, nocase?: boolean}} options
 */
export function safeMinimatch(value, pattern, options = {}) {
  if (!isSafeGlobPattern(pattern, options.maxBraceExpansions)) {
    return false;
  }
  try {
    return minimatch(value, pattern, {
      dot: true,
      nocase: options.nocase === true,
    });
  } catch {
    return false;
  }
}
