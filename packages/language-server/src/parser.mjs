import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query } from "web-tree-sitter";

import { LineMap } from "./protocol.mjs";
import { SEMANTIC_QUERY } from "./syntax-queries.mjs";

const LANGUAGE_WASM = new URL("../assets/tree-sitter-stylus.wasm", import.meta.url);

/** @type {Promise<{language: import("web-tree-sitter").Language, query: import("web-tree-sitter").Query}> | undefined} */
let runtimePromise;

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      await Parser.init();
      const language = await Language.load(fileURLToPath(LANGUAGE_WASM));
      return {
        language,
        query: new Query(language, SEMANTIC_QUERY),
      };
    })();
  }
  return runtimePromise;
}

/** @param {string} text @param {number} offset @returns {number} */
function avoidSplittingSurrogatePair(text, offset) {
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  ) {
    return offset - 1;
  }
  return offset;
}

/** Return the smallest single edit that changes oldText into newText. */
/** @param {string} oldText @param {string} newText */
export function computeIncrementalEdit(oldText, newText) {
  let start = 0;
  const shortest = Math.min(oldText.length, newText.length);
  while (start < shortest && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start += 1;
  }
  start = avoidSplittingSurrogatePair(oldText, start);

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  oldEnd = avoidSplittingSurrogatePair(oldText, oldEnd);
  newEnd = avoidSplittingSurrogatePair(newText, newEnd);

  const oldLines = new LineMap(oldText);
  const newLines = new LineMap(newText);
  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: oldLines.pointAt(start),
    oldEndPosition: oldLines.pointAt(oldEnd),
    newEndPosition: newLines.pointAt(newEnd),
  };
}

/**
 * An incrementally parsed Stylus syntax document. The tree owns WASM memory and
 * must be disposed when evicted from the document cache.
 */
export class ParsedStylusDocument {
  /**
   * @param {string} text
   * @param {import("web-tree-sitter").Tree} tree
   * @param {number} parseDurationMs
   * @param {boolean} incremental
   */
  constructor(text, tree, parseDurationMs, incremental) {
    this.text = text;
    this.tree = /** @type {import("web-tree-sitter").Tree | null} */ (tree);
    this.parseDurationMs = parseDurationMs;
    this.incremental = incremental;
  }

  dispose() {
    this.tree?.delete();
    this.tree = null;
  }
}

/**
 * Parse Stylus with a fresh parser instance, permitting independent requests.
 * @param {string} text
 * @param {ParsedStylusDocument | null} previous
 * @param {{readonly aborted: boolean, readonly reason?: unknown} | null} signal
 */
export async function parseStylus(text, previous = null, signal = null) {
  const { language } = await loadRuntime();
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Stylus parsing cancelled");
  }

  const parser = new Parser();
  parser.setLanguage(language);
  let oldTree = /** @type {import("web-tree-sitter").Tree | null} */ (null);
  try {
    if (previous?.tree) {
      oldTree = previous.tree.copy();
      oldTree.edit(computeIncrementalEdit(previous.text, text));
    }
    const started = performance.now();
    const tree = parser.parse(text, oldTree, {
      progressCallback: () => Boolean(signal?.aborted),
    });
    if (!tree) {
      throw signal?.reason ?? new Error("Tree-sitter did not produce a syntax tree");
    }
    return new ParsedStylusDocument(
      text,
      tree,
      performance.now() - started,
      Boolean(oldTree),
    );
  } finally {
    oldTree?.delete();
    parser.delete();
  }
}

/** @param {ParsedStylusDocument} parsedDocument */
export async function semanticCaptures(parsedDocument) {
  const { query } = await loadRuntime();
  if (!parsedDocument.tree) {
    throw new Error("Cannot query a disposed Stylus syntax tree");
  }
  return query.captures(parsedDocument.tree.rootNode);
}

export async function parserMetadata() {
  const { language } = await loadRuntime();
  return {
    name: language.name,
    abiVersion: language.abiVersion,
    nodeTypeCount: language.nodeTypeCount,
  };
}
