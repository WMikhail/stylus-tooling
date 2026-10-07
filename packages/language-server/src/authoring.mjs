import { getDefaultCSSDataProvider } from "vscode-css-languageservice";
import colorNames from "color-name";

/** @typedef {import("vscode-languageserver").Color} Color */
/** @typedef {import("vscode-languageserver").Range} Range */
/** @typedef {import("vscode-languageserver").ColorInformation} ColorInformation */
/** @typedef {import("vscode-languageserver").ColorPresentation} ColorPresentation */
/** @typedef {import("web-tree-sitter").Node} TreeNode */
/** @typedef {import("./semantic-model.mjs").SemanticModel} SemanticModel */

const cssProvider = getDefaultCSSDataProvider();
const CSS_PROPERTIES = cssProvider.provideProperties();
const CSS_PROPERTY_BY_NAME = new Map(
  CSS_PROPERTIES.map((property) => [property.name.toLowerCase(), property]),
);
const CSS_WIDE_VALUES = ["inherit", "initial", "revert", "revert-layer", "unset"];
const KNOWN_CSS_IDENTIFIERS = new Set([
  ...CSS_WIDE_VALUES,
  ...Object.keys(colorNames),
  "auto",
  "none",
  "normal",
  "currentcolor",
  "transparent",
  // These keywords are absent from the CSS provider's property.values.
  "pre",
  "pre-line",
  "pre-wrap",
  "ease",
  "ease-in",
  "ease-in-out",
  "ease-out",
  "linear",
  "step-end",
  "step-start",
]);
const KNOWN_CSS_FUNCTIONS = new Set([
  "attr",
  "calc",
  "clamp",
  "conic-gradient",
  "counter",
  "counters",
  "cross-fade",
  "element",
  "env",
  "fit-content",
  "image",
  "image-set",
  "linear-gradient",
  "max",
  "min",
  "paint",
  "radial-gradient",
  "repeating-conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "steps",
  "symbols",
  "url",
  "var",
]);
for (const property of CSS_PROPERTIES) {
  for (const value of property.values ?? []) {
    if (/^-?[_a-zA-Z][\w-]*$/.test(value.name ?? "")) {
      KNOWN_CSS_IDENTIFIERS.add(value.name.toLowerCase());
    }
    const functionName = /^(-?[_a-zA-Z][\w-]*)\(/.exec(value.name ?? "")?.[1];
    if (functionName) {
      KNOWN_CSS_FUNCTIONS.add(functionName.toLowerCase());
    }
  }
}

/** @param {string} value */
export function isKnownCssIdentifier(value) {
  return KNOWN_CSS_IDENTIFIERS.has(value.toLowerCase());
}

/** @param {string} value */
export function isKnownCssFunction(value) {
  return KNOWN_CSS_FUNCTIONS.has(value.toLowerCase());
}

/** @param {string | undefined} character */
function isCompletionCharacter(character) {
  return /[$A-Za-z0-9_.#-]/.test(character ?? "");
}

/** @param {string} text @param {number} offset */
export function completionPrefix(text, offset) {
  let start = Math.max(0, Math.min(offset, text.length));
  while (start > 0 && isCompletionCharacter(text[start - 1])) {
    start -= 1;
  }
  return { prefix: text.slice(start, offset), start };
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {{kind: "import", partial: string, start: number, end: number} | {kind: "extend" | "property"} | {kind: "value", property: string}}
 */
export function lineCompletionContext(text, offset) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const beforeCursor = text.slice(lineStart, offset);
  const trimmed = beforeCursor.trimStart();
  const contentStart = lineStart + beforeCursor.length - trimmed.length;
  for (const keyword of ["@import", "@require", "import", "require"]) {
    if (trimmed === keyword || trimmed.startsWith(`${keyword} `)) {
      let valueStart = contentStart + keyword.length;
      while (/\s/.test(text[valueStart] ?? "") && valueStart < offset) {
        valueStart += 1;
      }
      const quote =
        text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] : null;
      if (quote) {
        valueStart += 1;
        const closingQuote = text.indexOf(quote, valueStart);
        if (closingQuote !== -1 && offset > closingQuote + 1) {
          break;
        }
        const valueEnd =
          closingQuote !== -1 && offset > closingQuote ? closingQuote : offset;
        return {
          kind: "import",
          partial: text.slice(valueStart, valueEnd),
          start: valueStart,
          end: valueEnd,
        };
      }
      return {
        kind: "import",
        partial: text.slice(valueStart, offset),
        start: valueStart,
        end: offset,
      };
    }
  }
  if (trimmed.startsWith("@extend ") || trimmed.startsWith("@extends ")) {
    return { kind: "extend" };
  }
  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace === -1) {
    return { kind: "property" };
  }
  const property = trimmed.slice(0, firstWhitespace).replace(/:$/, "").toLowerCase();
  return { kind: "value", property };
}

/** @param {string} prefix */
export function cssPropertyCompletions(prefix = "") {
  const normalized = prefix.toLowerCase();
  return CSS_PROPERTIES.filter((property) =>
    property.name.toLowerCase().startsWith(normalized),
  ).map((property) => ({
    label: property.name,
    detail: property.description ?? property.syntax ?? "CSS property",
    documentation: property.description ?? null,
  }));
}

/** @param {string} propertyName @param {string} prefix */
export function cssValueCompletions(propertyName, prefix = "") {
  const property = CSS_PROPERTY_BY_NAME.get(propertyName?.toLowerCase());
  const values = [
    ...CSS_WIDE_VALUES,
    ...(property?.values ?? []).map((value) => value.name).filter(Boolean),
  ];
  const normalized = prefix.toLowerCase();
  return [...new Set(values)]
    .filter((value) => value.toLowerCase().startsWith(normalized))
    .map((value) => ({
      label: value,
      detail: property ? `Value for ${property.name}` : "CSS value",
    }));
}

/** @param {number} value */
function clampChannel(value) {
  return Math.max(0, Math.min(1, value));
}

/** @param {string} text @returns {Color | null} */
function parseHex(text) {
  const value = text.slice(1);
  const expanded =
    value.length <= 4
      ? [...value].map((character) => character + character).join("")
      : value;
  if (expanded.length !== 6 && expanded.length !== 8) {
    return null;
  }
  const number = Number.parseInt(expanded, 16);
  if (!Number.isFinite(number)) {
    return null;
  }
  return {
    red: ((number >>> (expanded.length === 8 ? 24 : 16)) & 0xff) / 255,
    green: ((number >>> (expanded.length === 8 ? 16 : 8)) & 0xff) / 255,
    blue: ((number >>> (expanded.length === 8 ? 8 : 0)) & 0xff) / 255,
    alpha: expanded.length === 8 ? (number & 0xff) / 255 : 1,
  };
}

/** @param {string} text @param {number} scale */
function numberOrPercentage(text, scale = 255) {
  const trimmed = text.trim();
  if (trimmed.endsWith("%")) {
    return Number.parseFloat(trimmed) / 100;
  }
  return Number.parseFloat(trimmed) / scale;
}

/** @param {string} text @returns {string[]} */
function parseFunctionParts(text) {
  const opening = text.indexOf("(");
  const closing = text.lastIndexOf(")");
  if (opening === -1 || closing <= opening) {
    return [];
  }
  return text
    .slice(opening + 1, closing)
    .replace("/", " ")
    .split(/[,\s]+/)
    .filter(Boolean);
}

/** @param {number} hue @param {number} saturation @param {number} lightness @returns {[number, number, number]} */
function hslToRgb(hue, saturation, lightness) {
  const normalizedHue = (((hue % 360) + 360) % 360) / 360;
  if (saturation === 0) {
    return [lightness, lightness, lightness];
  }
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  /** @param {number} offset */
  const channel = (offset) => {
    let value = normalizedHue + offset;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

/** @param {string} name @param {string} text @returns {Color | null} */
function parseColorFunction(name, text) {
  const values = parseFunctionParts(text);
  if ((name === "rgb" || name === "rgba") && values.length >= 3) {
    const channels = values.slice(0, 3).map((value) => numberOrPercentage(value));
    const alpha = values[3] === undefined ? 1 : numberOrPercentage(values[3], 1);
    if (![...channels, alpha].every(Number.isFinite)) {
      return null;
    }
    return {
      red: clampChannel(channels[0]),
      green: clampChannel(channels[1]),
      blue: clampChannel(channels[2]),
      alpha: clampChannel(alpha),
    };
  }
  if ((name === "hsl" || name === "hsla") && values.length >= 3) {
    const hue = Number.parseFloat(values[0]);
    const saturation = numberOrPercentage(values[1], 1);
    const lightness = numberOrPercentage(values[2], 1);
    const alpha = values[3] === undefined ? 1 : numberOrPercentage(values[3], 1);
    if (![hue, saturation, lightness, alpha].every(Number.isFinite)) {
      return null;
    }
    const [red, green, blue] = hslToRgb(hue, saturation, lightness);
    return {
      red: clampChannel(red),
      green: clampChannel(green),
      blue: clampChannel(blue),
      alpha: clampChannel(alpha),
    };
  }
  return null;
}

/** @param {TreeNode} node @param {(node: TreeNode) => void} callback */
function walk(node, callback) {
  callback(node);
  for (const child of node.namedChildren.filter(
    /** @returns {child is TreeNode} */ (child) => child !== null,
  )) {
    walk(child, callback);
  }
}

/** Extract static color literals from one semantic model's Tree-sitter AST. */
/** @param {SemanticModel} model @returns {ColorInformation[]} */
export function colorInformation(model) {
  const result = /** @type {ColorInformation[]} */ ([]);
  if (!model.parsed.tree) return result;
  walk(model.parsed.tree.rootNode, (node) => {
    let color = null;
    if (node.type === "color_value") {
      color = parseHex(node.text);
    } else if (node.type === "css_function_expression") {
      const functionName = node.childForFieldName("function")?.text?.toLowerCase();
      if (functionName && ["rgb", "rgba", "hsl", "hsla"].includes(functionName)) {
        color = parseColorFunction(functionName, node.text);
      }
    }
    if (color) {
      result.push({
        color,
        range: model.embedded.toHostRange(node.startIndex, node.endIndex),
      });
    }
  });
  return result;
}

/** @param {number} value */
function byte(value) {
  return Math.round(clampChannel(value) * 255);
}

/** @param {number} value */
function hexByte(value) {
  return byte(value).toString(16).padStart(2, "0");
}

/** @param {number} red @param {number} green @param {number} blue @returns {[number, number, number]} */
function rgbToHsl(red, green, blue) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) {
    return [0, 0, lightness];
  }
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  /** @type {number} */
  let hue;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return [hue * 60, saturation, lightness];
}

/** @param {Color} color @param {Range} range @returns {ColorPresentation[]} */
export function colorPresentations(color, range) {
  const alpha = clampChannel(color.alpha);
  const hex = `#${hexByte(color.red)}${hexByte(color.green)}${hexByte(color.blue)}${
    alpha < 1 ? hexByte(alpha) : ""
  }`;
  const rgb =
    alpha < 1
      ? `rgba(${byte(color.red)}, ${byte(color.green)}, ${byte(color.blue)}, ${alpha.toFixed(2)})`
      : `rgb(${byte(color.red)}, ${byte(color.green)}, ${byte(color.blue)})`;
  const [hue, saturation, lightness] = rgbToHsl(color.red, color.green, color.blue);
  const hsl =
    alpha < 1
      ? `hsla(${Math.round(hue)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%, ${alpha.toFixed(2)})`
      : `hsl(${Math.round(hue)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`;
  return [hex, rgb, hsl].map((label) => ({
    label,
    textEdit: { range, newText: label },
  }));
}

/** Count commas in the current call while ignoring nested calls and strings. */
/** @param {string} text @param {number} argumentsStart @param {number} cursorOffset */
export function activeParameter(text, argumentsStart, cursorOffset) {
  let depth = 0;
  let active = 0;
  let quote = /** @type {string | null} */ (null);
  for (let offset = argumentsStart + 1; offset < cursorOffset; offset += 1) {
    const character = text[offset];
    if (quote) {
      if (character === "\\") {
        offset += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      active += 1;
    }
  }
  return active;
}
