import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_FILE_URL_PATH = /^\/[A-Za-z]:\//;

/**
 * A cached mapping between JavaScript string offsets and LSP positions.
 * JavaScript offsets and LSP characters both count UTF-16 code units.
 */
export class LineMap {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.lineStarts = [0];
    for (let offset = 0; offset < text.length; offset += 1) {
      if (text.charCodeAt(offset) === 10) {
        this.lineStarts.push(offset + 1);
      }
    }
  }

  /** Convert a UTF-16 string offset to a zero-based LSP position. */
  /** @param {number} offset @returns {import("vscode-languageserver").Position} */
  positionAt(offset) {
    const bounded = Math.max(0, Math.min(offset ?? 0, this.text.length));
    let low = 0;
    let high = this.lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (this.lineStarts[middle] <= bounded) {
        low = middle;
      } else {
        high = middle;
      }
    }
    const start = this.lineStarts[low];
    return { line: low, character: bounded - start };
  }

  /** Convert a zero-based LSP position to a UTF-16 string offset. */
  /** @param {import("vscode-languageserver").Position} position @returns {number} */
  offsetAt(position) {
    const requestedLine = Math.max(0, position?.line ?? 0);
    if (requestedLine >= this.lineStarts.length) {
      return this.text.length;
    }
    const start = this.lineStarts[requestedLine];
    let end =
      requestedLine + 1 < this.lineStarts.length
        ? this.lineStarts[requestedLine + 1] - 1
        : this.text.length;
    if (end > start && this.text.charCodeAt(end - 1) === 13) {
      end -= 1;
    }
    const character = Math.max(0, position?.character ?? 0);
    return Math.min(start + character, end);
  }

  /** Return a Tree-sitter point whose column is also measured in UTF-16 units. */
  /** @param {number} offset @returns {{row: number, column: number}} */
  pointAt(offset) {
    const position = this.positionAt(offset);
    return { row: position.line, column: position.character };
  }

  /**
   * @param {number} startOffset
   * @param {number} endOffset
   * @returns {import("vscode-languageserver").Range}
   */
  range(startOffset, endOffset) {
    return {
      start: this.positionAt(startOffset),
      end: this.positionAt(endOffset),
    };
  }
}

/** @param {string} text @param {number} offset */
export function positionAt(text, offset) {
  return new LineMap(text).positionAt(offset);
}

/** @param {string} text @param {import("vscode-languageserver").Position} position */
export function offsetAt(text, position) {
  return new LineMap(text).offsetAt(position);
}

/** @param {string} text @param {number} startOffset @param {number} endOffset */
export function rangeForOffsets(text, startOffset, endOffset) {
  return new LineMap(text).range(startOffset, endOffset);
}

/** @param {string} value */
export function isWindowsPath(value) {
  return WINDOWS_ABSOLUTE_PATH.test(value ?? "");
}

/** Normalize a path without losing Windows drive semantics on non-Windows hosts. */
/** @param {string} filePath @returns {string} */
export function normalizeFilePath(filePath) {
  if (isWindowsPath(filePath)) {
    const normalized = path.win32.normalize(filePath.replaceAll("/", "\\"));
    return `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  }
  return path.resolve(filePath);
}

/** Convert either a native or Windows path into a canonical file URI. */
/** @param {string} filePath @returns {string} */
export function filePathToUri(filePath) {
  const normalized = normalizeFilePath(filePath);
  if (isWindowsPath(normalized)) {
    const pathname = normalized.replaceAll("\\", "/");
    return `file:///${encodeURI(pathname).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
  }
  return pathToFileURL(normalized).href;
}

/** Convert a file URI into a normalized path, including Windows URIs on POSIX. */
/** @param {string} uri @returns {string | null} */
export function uriToFilePath(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return null;
    }
    if (WINDOWS_FILE_URL_PATH.test(url.pathname)) {
      return normalizeFilePath(decodeURIComponent(url.pathname.slice(1)));
    }
    return normalizeFilePath(fileURLToPath(url));
  } catch {
    return null;
  }
}

/** A stable comparison key for paths and file URIs. */
/** @param {string} filePath @returns {string} */
export function canonicalPathKey(filePath) {
  const normalized = normalizeFilePath(filePath);
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * @param {{startOffset: number, endOffset: number}} range
 * @param {number} offset
 * @param {boolean} includeEnd
 */
export function containsOffset(range, offset, includeEnd = false) {
  return (
    offset >= range.startOffset &&
    (offset < range.endOffset || (includeEnd && offset === range.endOffset))
  );
}

/** @param {import("vscode-languageserver").Position} left @param {import("vscode-languageserver").Position} right */
export function comparePositions(left, right) {
  return left.line - right.line || left.character - right.character;
}
