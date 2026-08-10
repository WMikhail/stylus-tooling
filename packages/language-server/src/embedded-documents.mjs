import path from "node:path";

import { LineMap, uriToFilePath } from "./protocol.mjs";

const STYLUS_LANGUAGES = new Set(["styl", "stylus"]);

/** @type {Promise<typeof import("@vue/compiler-sfc")> | null} */
let vueCompilerPromise = null;
/** @type {Promise<typeof import("@astrojs/compiler")> | null} */
let astroCompilerPromise = null;

function loadVueCompiler() {
  vueCompilerPromise ??= import("@vue/compiler-sfc");
  return vueCompilerPromise;
}

function loadAstroCompiler() {
  astroCompilerPromise ??= import("@astrojs/compiler");
  return astroCompilerPromise;
}

/** @typedef {string | boolean} EmbeddedAttributeValue */
/** @typedef {Record<string, EmbeddedAttributeValue>} EmbeddedAttributes */
/** @typedef {"standalone" | "vue-style" | "svelte-style" | "astro-style"} EmbeddedKind */
/** @typedef {import("vscode-languageserver").Position} Position */
/** @typedef {import("vscode-languageserver").Range} Range */
/**
 * @typedef {{
 *   sourceStart: number,
 *   sourceEnd: number,
 *   localOffset: number,
 *   removedThrough: number,
 * }} IndentRemoval
 */
/**
 * @typedef {{
 *   name: string,
 *   kind?: string,
 *   value?: string,
 * }} AstroAttribute
 */
/**
 * @typedef {{
 *   type?: string,
 *   name?: string,
 *   attributes?: AstroAttribute[],
 *   position?: {
 *     start?: { offset?: number },
 *     end?: { offset?: number },
 *   },
 *   children?: AstroNode[],
 * }} AstroNode
 */

/** @param {string} text @returns {string} */
function commonIndentPrefix(text) {
  /** @type {string | null} */
  let common = null;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(
      lineStart,
      lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd,
    );
    if (/[^ \t]/.test(line)) {
      const indentation = /^[ \t]*/.exec(line)?.[0] ?? "";
      if (common === null) {
        common = indentation;
      } else {
        let length = Math.min(common.length, indentation.length);
        while (length > 0 && common.slice(0, length) !== indentation.slice(0, length)) {
          length -= 1;
        }
        common = common.slice(0, length);
      }
      if (!common) return "";
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return common ?? "";
}

/**
 * Remove host-language presentation indentation while recording a sparse,
 * reversible mapping between parser offsets and the original component slice.
 *
 * @param {string} sourceText
 * @returns {{text: string, removals: IndentRemoval[]}}
 */
function dedentEmbeddedText(sourceText) {
  const prefix = commonIndentPrefix(sourceText);
  if (!prefix) {
    return { text: sourceText, removals: [] };
  }

  const parts = [];
  /** @type {IndentRemoval[]} */
  const removals = [];
  let sourceStart = 0;
  let localOffset = 0;
  let removedThrough = 0;
  while (sourceStart < sourceText.length) {
    const newline = sourceText.indexOf("\n", sourceStart);
    const sourceEnd = newline === -1 ? sourceText.length : newline + 1;
    const removeIndent = sourceText.startsWith(prefix, sourceStart);
    const contentStart = sourceStart + (removeIndent ? prefix.length : 0);
    if (removeIndent) {
      removedThrough += prefix.length;
      removals.push({
        sourceStart,
        sourceEnd: contentStart,
        localOffset,
        removedThrough,
      });
    }
    const part = sourceText.slice(contentStart, sourceEnd);
    parts.push(part);
    localOffset += part.length;
    sourceStart = sourceEnd;
  }
  return { text: parts.join(""), removals };
}

/** @param {unknown} raw @returns {EmbeddedAttributeValue} */
function decodeAttributeValue(raw) {
  if (raw === true) {
    return true;
  }
  return typeof raw === "string" ? raw : String(raw ?? "");
}

/**
 * A view of a Stylus region embedded in a host document. Component-level
 * presentation indentation is removed for parsing and represented by sparse
 * offset mappings back into the untouched host text.
 */
export class EmbeddedDocument {
  /**
   * @param {{
   *   hostUri: string,
   *   hostText: string,
   *   index: number,
   *   text: string,
   *   hostStart: number,
   *   hostEnd: number,
   *   attributes: EmbeddedAttributes,
   *   kind: EmbeddedKind,
   * }} options
   */
  constructor({ hostUri, hostText, index, text, hostStart, hostEnd, attributes, kind }) {
    const normalized =
      kind === "standalone" ? { text, removals: [] } : dedentEmbeddedText(text);
    this.hostUri = hostUri;
    this.hostText = hostText;
    this.index = index;
    this.uri = `${hostUri}#stylus-${index}`;
    this.text = normalized.text;
    this.hostStart = hostStart;
    this.hostEnd = hostEnd;
    this.attributes = attributes;
    this.kind = kind;
    this.indentRemovals = normalized.removals;
    this.localLines = new LineMap(this.text);
    this.hostLines = new LineMap(hostText);
  }

  /** @param {number} offset @param {boolean} [includeEnd] */
  containsHostOffset(offset, includeEnd = false) {
    return (
      offset >= this.hostStart &&
      (offset < this.hostEnd || (includeEnd && offset === this.hostEnd))
    );
  }

  /** @param {number} localOffset @returns {number} */
  toHostOffset(localOffset) {
    const bounded = Math.max(0, Math.min(localOffset, this.text.length));
    let low = 0;
    let high = this.indentRemovals.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.indentRemovals[middle].localOffset <= bounded) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const removed = low > 0 ? this.indentRemovals[low - 1].removedThrough : 0;
    return this.hostStart + bounded + removed;
  }

  /** @param {number} hostOffset @returns {number} */
  toLocalOffset(hostOffset) {
    const sourceOffset = Math.max(
      0,
      Math.min(hostOffset - this.hostStart, this.hostEnd - this.hostStart),
    );
    let low = 0;
    let high = this.indentRemovals.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.indentRemovals[middle].sourceStart <= sourceOffset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low === 0) return Math.min(sourceOffset, this.text.length);
    const removal = this.indentRemovals[low - 1];
    if (sourceOffset <= removal.sourceEnd) {
      return removal.localOffset;
    }
    return Math.min(sourceOffset - removal.removedThrough, this.text.length);
  }

  /** @param {number} localStart @param {number} localEnd @returns {Range} */
  toHostRange(localStart, localEnd) {
    return this.hostLines.range(this.toHostOffset(localStart), this.toHostOffset(localEnd));
  }

  /** @param {Position} hostPosition @returns {Position} */
  toLocalPosition(hostPosition) {
    const hostOffset = this.hostLines.offsetAt(hostPosition);
    return this.localLines.positionAt(this.toLocalOffset(hostOffset));
  }
}

/** @param {string} uri @param {string} text @returns {EmbeddedDocument[]} */
function standaloneDocument(uri, text) {
  return [
    new EmbeddedDocument({
      hostUri: uri,
      hostText: text,
      index: 0,
      text,
      hostStart: 0,
      hostEnd: text.length,
      attributes: {},
      kind: "standalone",
    }),
  ];
}

/**
 * @param {string} uri
 * @param {string} text
 * @param {string} filePath
 * @returns {Promise<{ documents: EmbeddedDocument[], errors: unknown[] }>}
 */
async function vueDocuments(uri, text, filePath) {
  const { parse } = await loadVueCompiler();
  const result = parse(text, {
    filename: filePath,
    sourceMap: false,
  });
  /** @type {EmbeddedDocument[]} */
  const documents = [];
  for (const style of result.descriptor.styles) {
    if (!STYLUS_LANGUAGES.has((style.lang ?? "").toLowerCase())) {
      continue;
    }
    const hostStart = style.loc.start.offset;
    documents.push(
      new EmbeddedDocument({
        hostUri: uri,
        hostText: text,
        index: documents.length,
        text: style.content,
        hostStart,
        hostEnd: hostStart + style.content.length,
        attributes: Object.fromEntries(
          Object.entries(style.attrs).map(([name, value]) => [
            name,
            decodeAttributeValue(value),
          ]),
        ),
        kind: "vue-style",
      }),
    );
  }
  return { documents, errors: result.errors };
}

/** @param {string | undefined} character */
function isNameCharacter(character) {
  return /[A-Za-z0-9:_-]/.test(character ?? "");
}

/** @param {string} text @param {number} offset @returns {number} */
function skipWhitespace(text, offset) {
  while (/\s/.test(text[offset] ?? "")) {
    offset += 1;
  }
  return offset;
}

/** @param {string} text @param {number} start @returns {number} */
function skipSvelteExpression(text, start) {
  let depth = 1;
  /** @type {string | null} */
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let offset = start + 1; offset < text.length; offset += 1) {
    const character = text[offset];
    const next = text[offset + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        offset += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        offset += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      offset += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      offset += 1;
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return offset + 1;
    }
  }
  return text.length;
}

/**
 * @param {string} text
 * @param {number} cursor
 * @param {"svelte-style" | "astro-style"} kind
 * @returns {number}
 */
function nextTagOpening(text, cursor, kind) {
  if (kind !== "svelte-style") {
    return text.indexOf("<", cursor);
  }
  while (cursor < text.length) {
    const opening = text.indexOf("<", cursor);
    const expression = text.indexOf("{", cursor);
    if (opening === -1 || expression === -1 || opening < expression) {
      return opening;
    }
    cursor = skipSvelteExpression(text, expression);
  }
  return -1;
}

/**
 * Minimal token scanner for Svelte/Astro style tags. Vue intentionally uses
 * @vue/compiler-sfc above; this scanner never interprets script contents.
 *
 * @param {string} uri
 * @param {string} text
 * @param {"svelte-style" | "astro-style"} kind
 * @returns {EmbeddedDocument[]}
 */
function genericComponentDocuments(uri, text, kind) {
  /** @type {EmbeddedDocument[]} */
  const documents = [];
  const lowerText = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const opening = nextTagOpening(text, cursor, kind);
    if (opening === -1) {
      break;
    }
    if (text.startsWith("<!--", opening)) {
      const commentEnd = text.indexOf("-->", opening + 4);
      cursor = commentEnd === -1 ? text.length : commentEnd + 3;
      continue;
    }
    const closingTag = text[opening + 1] === "/";
    let nameStart = opening + (closingTag ? 2 : 1);
    while (/\s/.test(text[nameStart] ?? "")) {
      nameStart += 1;
    }
    let nameEnd = nameStart;
    while (isNameCharacter(text[nameEnd])) {
      nameEnd += 1;
    }
    const tagName = text.slice(nameStart, nameEnd).toLowerCase();
    if (!tagName || closingTag) {
      cursor = opening + 1;
      continue;
    }
    if (tagName === "script") {
      const closing = lowerText.indexOf("</script", nameEnd);
      const closeEnd = closing === -1 ? -1 : text.indexOf(">", closing + 8);
      cursor = closeEnd === -1 ? text.length : closeEnd + 1;
      continue;
    }
    if (tagName !== "style") {
      cursor = nameEnd;
      continue;
    }
    let index = nameEnd;
    /** @type {EmbeddedAttributes} */
    const attributes = {};
    let valid = true;
    while (index < text.length) {
      index = skipWhitespace(text, index);
      if (text[index] === ">") {
        index += 1;
        break;
      }
      if (text[index] === "/" && text[index + 1] === ">") {
        valid = false;
        index += 2;
        break;
      }
      const nameStart = index;
      while (isNameCharacter(text[index])) {
        index += 1;
      }
      if (nameStart === index) {
        valid = false;
        break;
      }
      const name = text.slice(nameStart, index).toLowerCase();
      index = skipWhitespace(text, index);
      /** @type {EmbeddedAttributeValue} */
      let value = true;
      if (text[index] === "=") {
        index = skipWhitespace(text, index + 1);
        const quote = text[index];
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, index + 1);
          if (end === -1) {
            valid = false;
            break;
          }
          value = text.slice(index + 1, end);
          index = end + 1;
        } else {
          const valueStart = index;
          while (index < text.length && !/\s|>/.test(text[index])) {
            index += 1;
          }
          value = text.slice(valueStart, index);
        }
      }
      attributes[name] = value;
    }
    if (!valid) {
      cursor = Math.max(index, opening + 6);
      continue;
    }
    const closing = lowerText.indexOf("</style", index);
    if (closing === -1) {
      break;
    }
    const lang = String(attributes.lang ?? attributes.type ?? "").toLowerCase();
    if (STYLUS_LANGUAGES.has(lang) || lang === "text/stylus") {
      documents.push(
        new EmbeddedDocument({
          hostUri: uri,
          hostText: text,
          index: documents.length,
          text: text.slice(index, closing),
          hostStart: index,
          hostEnd: closing,
          attributes,
          kind,
        }),
      );
    }
    const closeEnd = text.indexOf(">", closing + 7);
    cursor = closeEnd === -1 ? text.length : closeEnd + 1;
  }
  return documents;
}

/**
 * @param {string} uri
 * @param {string} text
 * @returns {Promise<{ documents: EmbeddedDocument[], errors: unknown[] }>}
 */
async function astroDocuments(uri, text) {
  const { parse } = await loadAstroCompiler();
  const parsed = await parse(text, { position: true });
  /** @type {EmbeddedDocument[]} */
  const documents = [];
  /** @param {AstroNode} node */
  const visit = (node) => {
    if (node?.type === "element" && node.name?.toLowerCase() === "style") {
      /** @type {EmbeddedAttributes} */
      const attributes = Object.fromEntries(
        (node.attributes ?? []).map((attribute) => [
          attribute.name.toLowerCase(),
          attribute.kind === "empty" ? true : decodeAttributeValue(attribute.value),
        ]),
      );
      const lang = String(attributes.lang ?? attributes.type ?? "").toLowerCase();
      if (STYLUS_LANGUAGES.has(lang) || lang === "text/stylus") {
        const elementStart = node.position?.start?.offset ?? 0;
        const elementEnd = node.position?.end?.offset ?? elementStart;
        const hostStart = text.indexOf(">", elementStart) + 1;
        const hostEnd = text.toLowerCase().lastIndexOf("</style", elementEnd);
        if (hostStart > 0 && hostEnd >= hostStart) {
          documents.push(
            new EmbeddedDocument({
              hostUri: uri,
              hostText: text,
              index: documents.length,
              text: text.slice(hostStart, hostEnd),
              hostStart,
              hostEnd,
              attributes,
              kind: "astro-style",
            }),
          );
        }
      }
    }
    for (const child of node?.children ?? []) {
      visit(child);
    }
  };
  for (const child of /** @type {AstroNode[]} */ (parsed.ast.children ?? [])) {
    visit(child);
  }
  return { documents, errors: parsed.diagnostics ?? [] };
}

/**
 * Extract all Stylus embedded documents without changing their contents.
 *
 * @param {string} uri
 * @param {string} text
 * @returns {Promise<{ documents: EmbeddedDocument[], errors: unknown[] }>}
 */
export async function extractEmbeddedDocuments(uri, text) {
  const filePath = uriToFilePath(uri);
  if (!filePath) {
    return { documents: [], errors: [] };
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".styl" || extension === ".stylus") {
    return { documents: standaloneDocument(uri, text), errors: [] };
  }
  if (extension === ".vue") {
    return vueDocuments(uri, text, filePath);
  }
  if (extension === ".svelte" || extension === ".astro") {
    if (extension === ".astro") {
      return astroDocuments(uri, text);
    }
    return {
      documents: genericComponentDocuments(uri, text, "svelte-style"),
      errors: [],
    };
  }
  return { documents: [], errors: [] };
}
