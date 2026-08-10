import { semanticCaptures } from "./parser.mjs";

/** @typedef {import("web-tree-sitter").Node} TreeNode */
/** @typedef {import("vscode-languageserver").Position} Position */
/** @typedef {import("vscode-languageserver").Range} Range */
/** @typedef {import("./embedded-documents.mjs").EmbeddedDocument} EmbeddedDocument */
/** @typedef {import("./parser.mjs").ParsedStylusDocument} ParsedStylusDocument */
/** @typedef {"variable" | "parameter" | "loop-variable" | "function" | "mixin" | "selector" | "placeholder" | "keyframes"} SymbolKind */
/** @typedef {SymbolKind | "callable"} ExpectedSymbolKind */
/**
 * @typedef {{
 *   name: string,
 *   defaultValue: string | null,
 *   rest: boolean,
 * }} SemanticParameter
 */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: SymbolKind,
 *   uri: string,
 *   embeddedUri: string,
 *   fullRange: Range,
 *   nameRange: Range,
 *   localFullStart: number,
 *   localFullEnd: number,
 *   localNameStart: number,
 *   localNameEnd: number,
 *   scopeId: string,
 *   parentScopeId: string | null,
 *   visibility: "document" | "lexical",
 *   visibilityStart: number | undefined,
 *   declarationOrder: number,
 *   value: string | null,
 *   signature: string | null,
 *   parameters: SemanticParameter[],
 *   documentation: string | null,
 * }} SemanticSymbol
 */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   uri: string,
 *   embeddedUri: string,
 *   range: Range,
 *   fullRange: Range,
 *   localFullStart: number,
 *   localFullEnd: number,
 *   localNameStart: number,
 *   localNameEnd: number,
 *   scopeId: string,
 *   expectedKinds: ExpectedSymbolKind[],
 *   role: string,
 *   resolvedSymbolIds: string[] | null,
 * }} SemanticReference
 */
/**
 * @typedef {{
 *   id: string,
 *   specifier: string,
 *   uri: string,
 *   embeddedUri: string,
 *   range: Range,
 *   nameRange: Range,
 *   localNameStart: number,
 *   localNameEnd: number,
 *   scopeId: string,
 *   resolvedUris: string[],
 * }} SemanticImport
 */
/**
 * @typedef {{
 *   message: string,
 *   range: Range,
 *   localStart: number,
 *   localEnd: number,
 * }} SemanticSyntaxError
 */
/** @typedef {SemanticSymbol | SemanticReference | SemanticImport} SemanticNamedItem */
/** @typedef {{ type: "reference", value: SemanticReference } | { type: "symbol", value: SemanticSymbol } | { type: "import", value: SemanticImport }} SemanticItem */
/**
 * @typedef {{
 *   insideKeyframes?: boolean,
 *   declarationProperty?: string | null,
 * }} TraversalContext
 */

const VARIABLE_KINDS = new Set(["variable", "parameter", "loop-variable"]);
const CALLABLE_KINDS = new Set(["function", "mixin"]);
const ANIMATION_KEYWORDS = new Set([
  "alternate",
  "alternate-reverse",
  "backwards",
  "both",
  "ease",
  "ease-in",
  "ease-in-out",
  "ease-out",
  "forwards",
  "infinite",
  "inherit",
  "initial",
  "linear",
  "none",
  "normal",
  "paused",
  "revert",
  "revert-layer",
  "reverse",
  "running",
  "step-end",
  "step-start",
  "unset",
]);
const SELECTOR_NODE_TYPES = new Set([
  "class_name",
  "id_name",
  "placeholder_selector",
  "tag_name",
]);

/** @param {TreeNode} node @returns {string} */
function nodeKey(node) {
  return `${node.startIndex}:${node.endIndex}:${node.type}`;
}

/** @param {TreeNode} node @returns {TreeNode[]} */
function childNodes(node) {
  return node.namedChildren.filter(
    /** @returns {child is TreeNode} */ (child) => child !== null,
  );
}

/** @param {TreeNode} node @param {string} name @returns {TreeNode | null} */
function field(node, name) {
  return node.childForFieldName(name);
}

/**
 * @param {TreeNode} node
 * @param {(node: TreeNode) => boolean} predicate
 * @param {TreeNode[]} [output]
 * @returns {TreeNode[]}
 */
function descendants(node, predicate, output = []) {
  for (const child of childNodes(node)) {
    if (predicate(child)) {
      output.push(child);
    }
    descendants(child, predicate, output);
  }
  return output;
}

/** @param {TreeNode} node @param {string} type @returns {boolean} */
function hasDescendant(node, type) {
  return descendants(node, (candidate) => candidate.type === type, []).length > 0;
}

/** @param {string} value @returns {string} */
function stripStringLiteral(value) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * @param {string} kind
 * @param {readonly string[] | null | undefined} expectedKinds
 * @returns {boolean}
 */
function symbolKindMatches(kind, expectedKinds) {
  if (!expectedKinds?.length) {
    return true;
  }
  for (const expected of expectedKinds) {
    if (expected === kind) {
      return true;
    }
    if (expected === "variable" && VARIABLE_KINDS.has(kind)) {
      return true;
    }
    if (expected === "callable" && CALLABLE_KINDS.has(kind)) {
      return true;
    }
    if ((expected === "function" || expected === "mixin") && CALLABLE_KINDS.has(kind)) {
      return true;
    }
    if (expected === "selector" && (kind === "selector" || kind === "placeholder")) {
      return true;
    }
  }
  return false;
}

/** @param {SemanticSymbol} symbol @param {number} referenceOffset */
function declarationIsVisible(symbol, referenceOffset) {
  if (symbol.visibilityStart !== undefined && referenceOffset < symbol.visibilityStart) {
    return false;
  }
  if (
    symbol.kind === "function" ||
    symbol.kind === "mixin" ||
    symbol.kind === "selector" ||
    symbol.kind === "placeholder" ||
    symbol.kind === "keyframes" ||
    symbol.kind === "parameter" ||
    symbol.kind === "loop-variable"
  ) {
    return true;
  }
  return symbol.localNameStart <= referenceOffset;
}

/** @param {string} text @param {number} startOffset @returns {string | null} */
function adjacentDocumentation(text, startOffset) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const before = text.slice(0, lineStart);
  const lines = before.split(/\r?\n/);
  const collected = [];
  let inBlock = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (collected.length) {
        break;
      }
      continue;
    }
    if (trimmed.endsWith("*/")) {
      inBlock = true;
    }
    if (inBlock) {
      collected.push(trimmed.replace(/^\/\*+|\*+\/$/g, "").replace(/^\*\s?/, ""));
      if (trimmed.startsWith("/*")) {
        break;
      }
      continue;
    }
    if (trimmed.startsWith("//")) {
      collected.push(trimmed.slice(2).trim());
      continue;
    }
    break;
  }
  return collected.reverse().filter(Boolean).join("\n") || null;
}

/** A semantic scope with a stable parent relation and local declaration order. */
class SemanticScope {
  /**
   * @param {{
   *   id: string,
   *   type: string,
   *   startOffset: number,
   *   endOffset: number,
   *   parentId: string | null,
   *   depth: number,
   * }} options
   */
  constructor({ id, type, startOffset, endOffset, parentId, depth }) {
    this.id = id;
    this.type = type;
    this.startOffset = startOffset;
    this.endOffset = endOffset;
    this.parentId = parentId;
    this.depth = depth;
    /** @type {string[]} */
    this.symbolIds = [];
  }
}

/**
 * Semantic information for one embedded Stylus document. All externally
 * visible ranges are already mapped back into the host document.
 */
export class SemanticModel {
  /**
   * @param {{
   *   embedded: EmbeddedDocument,
   *   parsed: ParsedStylusDocument,
   *   scopes: SemanticScope[],
   *   symbols: SemanticSymbol[],
   *   references: SemanticReference[],
   *   imports: SemanticImport[],
   *   syntaxErrors: SemanticSyntaxError[],
   * }} options
   */
  constructor({ embedded, parsed, scopes, symbols, references, imports, syntaxErrors }) {
    this.uri = embedded.hostUri;
    this.embedded = embedded;
    this.parsed = parsed;
    this.scopes = scopes;
    this.scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
    this.symbols = symbols;
    this.symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    this.references = references;
    this.imports = imports;
    this.syntaxErrors = syntaxErrors;
  }

  dispose() {
    this.parsed?.dispose();
  }

  /** @param {number} offset @returns {SemanticScope | null} */
  scopeAtLocalOffset(offset) {
    let best = this.scopes[0] ?? null;
    for (const scope of this.scopes) {
      if (
        offset >= scope.startOffset &&
        offset <= scope.endOffset &&
        (!best || scope.depth > best.depth)
      ) {
        best = scope;
      }
    }
    return best;
  }

  /** Resolve lexical declarations before imports or workspace fallbacks. */
  /**
   * @param {string} name
   * @param {readonly string[]} expectedKinds
   * @param {number} localOffset
   * @param {string | null} [scopeId]
   * @returns {SemanticSymbol[]}
   */
  resolveLocal(name, expectedKinds, localOffset, scopeId = null) {
    let scope = scopeId
      ? this.scopeById.get(scopeId)
      : this.scopeAtLocalOffset(localOffset);
    while (scope) {
      /** @type {SemanticSymbol[]} */
      const candidates = [];
      for (const id of scope.symbolIds) {
        const symbol = this.symbolById.get(id);
        if (
          symbol &&
          symbol.name === name &&
          symbolKindMatches(symbol.kind, expectedKinds) &&
          declarationIsVisible(symbol, localOffset)
        ) {
          candidates.push(symbol);
        }
      }
      candidates.sort(
        (left, right) =>
          right.declarationOrder - left.declarationOrder ||
          right.localNameStart - left.localNameStart,
      );
      if (candidates.length) {
        const bestOrder = candidates[0]?.declarationOrder;
        return candidates.filter((candidate) => candidate.declarationOrder === bestOrder);
      }
      scope = scope.parentId ? this.scopeById.get(scope.parentId) : null;
    }
    return [];
  }

  /** @param {Position} position @returns {number | null} */
  embeddedAtPosition(position) {
    const hostOffset = this.embedded.hostLines.offsetAt(position);
    return this.embedded.containsHostOffset(hostOffset, true) ? hostOffset : null;
  }

  /** @param {Position} position @returns {SemanticItem | null} */
  itemAtPosition(position) {
    const hostOffset = this.embeddedAtPosition(position);
    if (hostOffset === null) {
      return null;
    }
    const localOffset = this.embedded.toLocalOffset(hostOffset);
    /** @param {SemanticNamedItem} item */
    const contains = (item) =>
      localOffset >= item.localNameStart &&
      (localOffset < item.localNameEnd ||
        (localOffset === item.localNameEnd && item.localNameEnd > item.localNameStart));
    /** @type {SemanticItem[]} */
    const candidates = [
      ...this.references.map(
        (value) => /** @type {SemanticItem} */ ({ type: "reference", value }),
      ),
      ...this.symbols.map(
        (value) => /** @type {SemanticItem} */ ({ type: "symbol", value }),
      ),
      ...this.imports.map(
        (value) => /** @type {SemanticItem} */ ({ type: "import", value }),
      ),
    ].filter((candidate) => contains(candidate.value));
    candidates.sort(
      (left, right) =>
        left.value.localNameEnd -
        left.value.localNameStart -
        (right.value.localNameEnd - right.value.localNameStart),
    );
    return candidates[0] ?? null;
  }

  /** @param {string} symbolId @returns {SemanticReference[]} */
  referenceForSymbol(symbolId) {
    return this.references.filter((reference) =>
      reference.resolvedSymbolIds?.includes(symbolId),
    );
  }
}

/** Map a parsed tree and its query captures into scopes, symbols, and references. */
/**
 * @param {EmbeddedDocument} embedded
 * @param {ParsedStylusDocument} parsed
 * @returns {Promise<SemanticModel>}
 */
export async function buildSemanticModel(embedded, parsed) {
  const captures = await semanticCaptures(parsed);
  /** @type {Map<string, Set<string>>} */
  const captureNames = new Map();
  for (const capture of captures) {
    const key = nodeKey(capture.node);
    const names = captureNames.get(key) ?? new Set();
    names.add(capture.name);
    captureNames.set(key, names);
  }
  /** @param {TreeNode} node @param {string} name */
  const capturedAs = (node, name) => captureNames.get(nodeKey(node))?.has(name) ?? false;

  /** @type {SemanticScope[]} */
  const scopes = [];
  /** @type {SemanticSymbol[]} */
  const symbols = [];
  /** @type {SemanticReference[]} */
  const references = [];
  /** @type {SemanticImport[]} */
  const imports = [];
  /** @type {SemanticSyntaxError[]} */
  const syntaxErrors = [];
  const definitionNodes = new Set();
  let declarationOrder = 0;
  let scopeSequence = 0;

  /**
   * @param {string} type
   * @param {TreeNode | null} node
   * @param {SemanticScope | null} parent
   * @returns {SemanticScope}
   */
  const addScope = (type, node, parent) => {
    const scope = new SemanticScope({
      id: `${embedded.uri}:scope:${scopeSequence++}`,
      type,
      startOffset: node?.startIndex ?? 0,
      endOffset: node?.endIndex ?? embedded.text.length,
      parentId: parent?.id ?? null,
      depth: (parent?.depth ?? -1) + 1,
    });
    scopes.push(scope);
    return scope;
  };

  const tree = parsed.tree;
  if (!tree) {
    throw new Error("Cannot build a semantic model from a disposed syntax tree");
  }
  const fileScope = addScope("file", tree.rootNode, null);

  /** @param {number} start @param {number} end @returns {Range} */
  const mappedRange = (start, end) => embedded.toHostRange(start, end);
  /**
   * @param {{
   *   nameNode: TreeNode | null,
   *   fullNode: TreeNode,
   *   kind: SymbolKind,
   *   scope: SemanticScope,
   *   value?: string | null,
   *   signature?: string | null,
   *   visibilityStart?: number,
   *   parameters?: SemanticParameter[]
   * }} input
   * @returns {SemanticSymbol | null}
   */
  const addSymbol = ({
    nameNode,
    fullNode,
    kind,
    scope,
    value = null,
    signature = null,
    visibilityStart = undefined,
    parameters = [],
  }) => {
    if (!nameNode || !nameNode.text) {
      return null;
    }
    definitionNodes.add(nodeKey(nameNode));
    const localNameStart = nameNode.startIndex;
    const localNameEnd = nameNode.endIndex;
    /** @type {SemanticSymbol} */
    const symbol = {
      id: `${embedded.uri}:symbol:${kind}:${localNameStart}:${nameNode.text}`,
      name: nameNode.text,
      kind,
      uri: embedded.hostUri,
      embeddedUri: embedded.uri,
      fullRange: mappedRange(fullNode.startIndex, fullNode.endIndex),
      nameRange: mappedRange(localNameStart, localNameEnd),
      localFullStart: fullNode.startIndex,
      localFullEnd: fullNode.endIndex,
      localNameStart,
      localNameEnd,
      scopeId: scope.id,
      parentScopeId: scope.parentId,
      visibility: scope.type === "file" ? "document" : "lexical",
      visibilityStart,
      declarationOrder: declarationOrder++,
      value,
      signature,
      parameters,
      documentation: adjacentDocumentation(embedded.text, fullNode.startIndex),
    };
    symbols.push(symbol);
    scope.symbolIds.push(symbol.id);
    return symbol;
  };

  /**
   * @param {{
   *   nameNode: TreeNode | null,
   *   expectedKinds: ExpectedSymbolKind[],
   *   scope: SemanticScope,
   *   role?: string,
   *   fullNode?: TreeNode | null,
   * }} input
   * @returns {SemanticReference | null}
   */
  const addReference = ({
    nameNode,
    expectedKinds,
    scope,
    role = "usage",
    fullNode = nameNode,
  }) => {
    if (!nameNode?.text || definitionNodes.has(nodeKey(nameNode))) {
      return null;
    }
    const referenceNode = fullNode ?? nameNode;
    const reference = /** @type {SemanticReference} */ ({
      id: `${embedded.uri}:reference:${role}:${nameNode.startIndex}:${nameNode.text}`,
      name: nameNode.text,
      uri: embedded.hostUri,
      embeddedUri: embedded.uri,
      range: mappedRange(nameNode.startIndex, nameNode.endIndex),
      fullRange: mappedRange(referenceNode.startIndex, referenceNode.endIndex),
      localFullStart: referenceNode.startIndex,
      localFullEnd: referenceNode.endIndex,
      localNameStart: nameNode.startIndex,
      localNameEnd: nameNode.endIndex,
      scopeId: scope.id,
      expectedKinds,
      role,
      resolvedSymbolIds: null,
    });
    references.push(reference);
    return reference;
  };

  /**
   * @param {TreeNode} selectorNode
   * @param {TreeNode} fullNode
   * @param {SemanticScope} scope
   */
  const addSelectorSymbols = (selectorNode, fullNode, scope) => {
    for (const nameNode of descendants(
      selectorNode,
      (candidate) => SELECTOR_NODE_TYPES.has(candidate.type),
      [],
    )) {
      addSymbol({
        nameNode,
        fullNode,
        kind: nameNode.type === "placeholder_selector" ? "placeholder" : "selector",
        scope,
      });
    }
  };

  /** @param {TreeNode} selectorNode @param {SemanticScope} scope */
  const addExtendReferences = (selectorNode, scope) => {
    for (const nameNode of descendants(
      selectorNode,
      (candidate) => SELECTOR_NODE_TYPES.has(candidate.type),
      [],
    )) {
      addReference({
        nameNode,
        expectedKinds:
          nameNode.type === "placeholder_selector" ? ["placeholder"] : ["selector"],
        scope,
        role: "extend",
      });
    }
  };

  /**
   * @param {TreeNode} node
   * @param {SemanticScope} scope
   * @param {TraversalContext} [context]
   */
  const visit = (node, scope, context = {}) => {
    if (node.isError || node.isMissing || capturedAs(node, "syntax.error")) {
      syntaxErrors.push({
        message: node.isMissing ? `Missing ${node.type}` : `Unexpected ${node.type}`,
        range: mappedRange(node.startIndex, Math.max(node.startIndex + 1, node.endIndex)),
        localStart: node.startIndex,
        localEnd: node.endIndex,
      });
    }

    if (node.isError) {
      const possibleName = node.namedChild(0);
      const hasAssignmentOperator = node.children.some((child) =>
        ["=", "?=", ":=", "+=", "-=", "*=", "/=", "%="].includes(child?.type ?? ""),
      );
      if (possibleName?.type === "variable_name" && hasAssignmentOperator) {
        addSymbol({
          nameNode: possibleName,
          fullNode: node,
          kind: "variable",
          scope,
          value: null,
        });
      }
    }

    if (node.type === "function_statement") {
      const nameNode = field(node, "name");
      const parametersNode = field(node, "parameters");
      const kind = hasDescendant(node, "return_statement") ? "function" : "mixin";
      /** @type {SemanticParameter[]} */
      const parameters = parametersNode
        ? descendants(parametersNode, (candidate) => candidate.type === "parameter", [])
            .map((parameter) => ({
              name: field(parameter, "name")?.text ?? "",
              defaultValue: field(parameter, "value")?.text ?? null,
              rest: parameter.children.some((child) => child?.type === "..."),
            }))
            .filter((parameter) => parameter.name)
        : [];
      const parameterNames = parameters.map(
        (parameter) =>
          `${parameter.name}${parameter.rest ? "..." : ""}${
            parameter.defaultValue !== null ? ` = ${parameter.defaultValue}` : ""
          }`,
      );
      addSymbol({
        nameNode,
        fullNode: node,
        kind,
        scope,
        signature: `${nameNode?.text ?? ""}(${parameterNames.join(", ")})`,
        parameters,
      });
      const functionScope = addScope(kind, node, scope);
      for (const child of childNodes(node)) {
        visit(child, functionScope, context);
      }
      return;
    }

    if (
      node.type === "each_statement" ||
      node.type === "for_statement" ||
      node.type === "postfix_for_clause"
    ) {
      const loopScope = addScope("loop", node, scope);
      const bodyStart =
        field(node, "body")?.startIndex ??
        childNodes(node).find((child) => child.type === "block")?.startIndex ??
        node.endIndex;
      for (const name of ["item", "index"]) {
        const nameNode = field(node, name);
        if (nameNode) {
          addSymbol({
            nameNode,
            fullNode: node,
            kind: "loop-variable",
            scope: loopScope,
            visibilityStart: bodyStart,
          });
        }
      }
      for (const child of childNodes(node)) {
        visit(child, loopScope, context);
      }
      return;
    }

    if (node.type === "block") {
      const blockScope = addScope("block", node, scope);
      for (const child of childNodes(node)) {
        visit(child, blockScope, context);
      }
      return;
    }

    if (node.type === "assignment" || node.type === "block_assignment") {
      const nameNode = field(node, "left");
      const rightNodes = node
        .childrenForFieldName("right")
        .filter(/** @returns {child is TreeNode} */ (child) => child !== null);
      addSymbol({
        nameNode,
        fullNode: node,
        kind: "variable",
        scope,
        value: rightNodes.map((candidate) => candidate.text).join(", ") || null,
      });
    } else if (node.type === "parameter") {
      const nameNode = field(node, "name");
      const valueNode = field(node, "value");
      addSymbol({
        nameNode,
        fullNode: node,
        kind: "parameter",
        scope,
        value: valueNode?.text ?? null,
      });
    } else if (node.type === "keyframes_statement") {
      addSymbol({
        nameNode: field(node, "name"),
        fullNode: node,
        kind: "keyframes",
        scope,
      });
      context = { ...context, insideKeyframes: true };
    } else if (node.type === "rule_set" && !context.insideKeyframes) {
      const selectorNode = field(node, "selector");
      if (selectorNode) {
        addSelectorSymbols(selectorNode, node, scope);
      }
    } else if (node.type === "import_statement") {
      const sourceNode = field(node, "source");
      if (sourceNode && capturedAs(sourceNode, "import.source")) {
        const quoted = sourceNode.text;
        const inset = quoted.length >= 2 && /["']/.test(quoted[0]) ? 1 : 0;
        const localNameStart = sourceNode.startIndex + inset;
        const localNameEnd = sourceNode.endIndex - inset;
        imports.push({
          id: `${embedded.uri}:import:${sourceNode.startIndex}`,
          specifier: stripStringLiteral(quoted),
          uri: embedded.hostUri,
          embeddedUri: embedded.uri,
          range: mappedRange(sourceNode.startIndex, sourceNode.endIndex),
          nameRange: mappedRange(localNameStart, localNameEnd),
          localNameStart,
          localNameEnd,
          scopeId: scope.id,
          resolvedUris: [],
        });
      }
    } else if (node.type === "call_expression") {
      const nameNode = field(node, "function");
      if (nameNode && capturedAs(nameNode, "reference.callable")) {
        let container = node.parent;
        while (
          container &&
          ["expression", "parenthesized_expression"].includes(container.type)
        ) {
          container = container.parent;
        }
        const expectedKind =
          container?.type === "expression_statement" ||
          container?.type === "stylesheet" ||
          container?.type === "block"
            ? "mixin"
            : "function";
        addReference({
          nameNode,
          expectedKinds: [expectedKind],
          scope,
          role: "call",
          fullNode: node,
        });
      }
    } else if (node.type === "extend_target") {
      const selectorNode = field(node, "selector");
      if (selectorNode) {
        addExtendReferences(selectorNode, scope);
      }
    } else if (
      node.type === "variable_name" &&
      capturedAs(node, "reference.variable") &&
      !definitionNodes.has(nodeKey(node))
    ) {
      const inAnimation =
        context.declarationProperty === "animation" ||
        context.declarationProperty === "animation-name";
      const animationKeyword =
        inAnimation &&
        !node.text.startsWith("$") &&
        ANIMATION_KEYWORDS.has(node.text.toLowerCase());
      if (!animationKeyword) {
        const animationName = inAnimation && !node.text.startsWith("$");
        addReference({
          nameNode: node,
          expectedKinds: animationName ? ["variable", "keyframes"] : ["variable"],
          scope,
          role: animationName ? "keyframes" : "usage",
        });
      }
    }

    let childContext = context;
    if (node.type === "declaration") {
      childContext = {
        ...context,
        declarationProperty: field(node, "property")?.text?.toLowerCase() ?? null,
      };
    }
    for (const child of childNodes(node)) {
      visit(child, scope, childContext);
    }
  };

  visit(tree.rootNode, fileScope);

  /** @type {Map<string, SemanticReference>} */
  const uniqueReferences = new Map();
  for (const reference of references) {
    const key = `${reference.localNameStart}:${reference.localNameEnd}:${reference.role}`;
    uniqueReferences.set(key, reference);
  }
  /** @type {Map<string, SemanticSyntaxError>} */
  const uniqueErrors = new Map();
  for (const error of syntaxErrors) {
    uniqueErrors.set(`${error.localStart}:${error.localEnd}:${error.message}`, error);
  }

  return new SemanticModel({
    embedded,
    parsed,
    scopes,
    symbols,
    references: [...uniqueReferences.values()].sort(
      (left, right) => left.localNameStart - right.localNameStart,
    ),
    imports,
    syntaxErrors: [...uniqueErrors.values()],
  });
}

/**
 * @param {string} kind
 * @param {readonly string[]} expectedKinds
 * @returns {boolean}
 */
export function compatibleSymbolKind(kind, expectedKinds) {
  return symbolKindMatches(kind, expectedKinds);
}
