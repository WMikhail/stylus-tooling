import {
  activeParameter,
  colorInformation,
  colorPresentations,
  completionPrefix,
  cssPropertyCompletions,
  cssValueCompletions,
  lineCompletionContext,
} from "./authoring.mjs";

/** @typedef {{readonly aborted: boolean, readonly reason?: unknown}} CancellationSignal */
/** @typedef {import("vscode-languageserver").Position} Position */
/** @typedef {import("vscode-languageserver").CompletionList} CompletionList */
/** @typedef {import("vscode-languageserver").CompletionItem} CompletionItem */
/** @typedef {import("vscode-languageserver").Hover} Hover */
/** @typedef {import("vscode-languageserver").SignatureHelp} SignatureHelp */
/** @typedef {import("vscode-languageserver").DocumentSymbol} DocumentSymbol */
/** @typedef {import("vscode-languageserver").SymbolInformation} SymbolInformation */
/** @typedef {import("vscode-languageserver").Color} Color */
/** @typedef {import("vscode-languageserver").Range} Range */
/** @typedef {import("vscode-languageserver").ColorInformation} ColorInformation */
/** @typedef {import("vscode-languageserver").ColorPresentation} ColorPresentation */
/** @typedef {import("./semantic-model.mjs").SemanticModel} SemanticModel */
/** @typedef {import("./semantic-model.mjs").SemanticItem} SemanticItem */
/** @typedef {import("./semantic-model.mjs").SemanticReference} SemanticReference */
/** @typedef {import("./semantic-model.mjs").SemanticSymbol} SemanticSymbol */
/** @typedef {import("./workspace-settings.mjs").WorkspaceSettings} WorkspaceSettings */
/** @typedef {import("./import-resolver.mjs").ImportResolver} ImportResolver */
/**
 * @typedef {{
 *   uri: string,
 *   filePath: string,
 *   text: string,
 *   models: SemanticModel[],
 * }} AuthoringDocument
 */
/** @typedef {{symbol: SemanticSymbol, depth: number, order: number}} ImportedSymbol */

const LSP_SYMBOL_KINDS = {
  variable: 13,
  parameter: 13,
  "loop-variable": 13,
  function: 12,
  mixin: 12,
  selector: 5,
  placeholder: 11,
  keyframes: 24,
};

/** @param {SemanticSymbol} symbol */
function locationForSymbol(symbol) {
  return { uri: symbol.uri, range: symbol.nameRange };
}

/**
 * Implements completion, hover, signature help, symbols, and color features
 * without owning workspace lifecycle or caches.
 */
export class WorkspaceAuthoring {
  /**
   * @param {{
   *   getDocument: (uri: string) => Promise<AuthoringDocument | null>,
   *   modelAt: (document: AuthoringDocument, position: Position) => SemanticModel | null,
   *   symbolsAt: (uri: string, position: Position, signal: CancellationSignal | null) => Promise<{item: SemanticItem | null, symbols: SemanticSymbol[]}>,
   *   resolveReference: (model: SemanticModel, reference: SemanticReference, signal: CancellationSignal | null) => Promise<SemanticSymbol[]>,
   *   allImportedSymbols: (model: SemanticModel, signal: CancellationSignal | null) => Promise<ImportedSymbol[]>,
   *   importedSymbols: (model: SemanticModel, name: string, expectedKinds: string[], signal: CancellationSignal | null) => Promise<SemanticSymbol[]>,
   *   waitUntilReady: () => Promise<void>,
   *   workspaceSymbols: () => Iterable<SemanticSymbol>,
   *   resolver: ImportResolver,
   *   settings: () => WorkspaceSettings
   * }} host
   */
  constructor(host) {
    this.host = host;
  }

  /** @param {string} uri @returns {Promise<DocumentSymbol[]>} */
  async documentSymbols(uri) {
    const document = await this.host.getDocument(uri);
    if (!document) {
      return [];
    }
    return document.models
      .flatMap((model) => model.symbols)
      .map((symbol) => ({
        name: symbol.name,
        detail:
          symbol.signature ??
          (symbol.value !== null && symbol.value !== undefined
            ? `${symbol.kind} = ${symbol.value}`
            : symbol.kind),
        kind: /** @type {DocumentSymbol["kind"]} */ (LSP_SYMBOL_KINDS[symbol.kind] ?? 13),
        range: symbol.fullRange,
        selectionRange: symbol.nameRange,
      }))
      .sort(
        (left, right) =>
          left.range.start.line - right.range.start.line ||
          left.range.start.character - right.range.start.character ||
          left.name.localeCompare(right.name),
      );
  }

  /**
   * @param {string} query
   * @param {CancellationSignal | null} signal
   * @returns {Promise<SymbolInformation[]>}
   */
  async workspaceSymbols(query = "", signal = null) {
    await this.host.waitUntilReady();
    const normalizedQuery = query.toLowerCase();
    /** @type {SymbolInformation[]} */
    const result = [];
    for (const symbol of this.host.workspaceSymbols()) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Workspace symbol search cancelled");
      }
      if (normalizedQuery && !symbol.name.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      result.push({
        name: symbol.name,
        kind: /** @type {SymbolInformation["kind"]} */ (
          LSP_SYMBOL_KINDS[symbol.kind] ?? 13
        ),
        location: locationForSymbol(symbol),
        containerName: symbol.kind,
      });
      if (result.length >= 1_000) {
        break;
      }
    }
    return result.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.location.uri.localeCompare(right.location.uri) ||
        left.location.range.start.line - right.location.range.start.line,
    );
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<CompletionList>}
   */
  async completion(uri, position, signal = null) {
    const document = await this.host.getDocument(uri);
    const model = document ? this.host.modelAt(document, position) : null;
    if (!document || !model) {
      return { isIncomplete: false, items: [] };
    }
    const hostOffset = model.embedded.hostLines.offsetAt(position);
    const localOffset = model.embedded.toLocalOffset(hostOffset);
    const context = lineCompletionContext(model.embedded.text, localOffset);
    if (context.kind === "import") {
      const completion = await this.host.resolver.complete(
        context.partial,
        document.filePath,
        signal,
      );
      const range = model.embedded.toHostRange(context.start, context.end);
      return {
        isIncomplete: completion.isIncomplete,
        items: completion.items.map((candidate) => ({
          label: candidate.label,
          kind: candidate.kind === "file" ? 17 : candidate.kind === "folder" ? 19 : 9,
          detail: `${candidate.via} import`,
          textEdit: { range, newText: candidate.label },
        })),
      };
    }

    const { prefix, start } = completionPrefix(model.embedded.text, localOffset);
    const normalizedPrefix = prefix.toLowerCase();
    const scope = model.scopeAtLocalOffset(localOffset);
    /** @type {{symbol: SemanticSymbol, rank: number}[]} */
    const ranked = [];
    const seenNames = new Set();
    let currentScope = scope;
    let lexicalDistance = 0;
    while (currentScope) {
      for (const symbolId of [...currentScope.symbolIds].reverse()) {
        const symbol = model.symbolById.get(symbolId);
        if (!symbol || seenNames.has(symbol.name)) {
          continue;
        }
        const resolved = model.resolveLocal(
          symbol.name,
          [symbol.kind],
          localOffset,
          scope?.id,
        );
        if (!resolved.some((candidate) => candidate.id === symbol.id)) {
          continue;
        }
        seenNames.add(symbol.name);
        ranked.push({ symbol, rank: lexicalDistance });
      }
      currentScope = currentScope.parentId
        ? (model.scopeById.get(currentScope.parentId) ?? null)
        : null;
      lexicalDistance += 1;
    }
    for (const imported of await this.host.allImportedSymbols(model, signal)) {
      if (!seenNames.has(imported.symbol.name)) {
        seenNames.add(imported.symbol.name);
        ranked.push({
          symbol: imported.symbol,
          rank: 100 + imported.depth * 10 - Math.min(imported.order, 9),
        });
      }
    }

    const expected =
      context.kind === "extend"
        ? new Set(["selector", "placeholder"])
        : prefix.startsWith("$")
          ? new Set(["variable", "parameter", "loop-variable", "placeholder"])
          : null;
    const semanticItems = ranked
      .filter(({ symbol }) => !expected || expected.has(symbol.kind))
      .filter(({ symbol }) => symbol.name.toLowerCase().startsWith(normalizedPrefix))
      .map(({ symbol, rank }) => ({
        label: symbol.name,
        kind:
          symbol.kind === "function" || symbol.kind === "mixin"
            ? 3
            : symbol.kind === "selector" || symbol.kind === "placeholder"
              ? 7
              : symbol.kind === "keyframes"
                ? 12
                : 6,
        detail:
          symbol.signature ?? `${symbol.kind}${symbol.value ? ` = ${symbol.value}` : ""}`,
        documentation: symbol.documentation ?? undefined,
        sortText: `${String(rank).padStart(4, "0")}:${symbol.name}`,
        filterText: symbol.name,
        textEdit: {
          range: model.embedded.toHostRange(start, localOffset),
          newText: symbol.name,
        },
      }));

    /** @type {CompletionItem[]} */
    const cssItems = [];
    if (context.kind === "property") {
      for (const property of cssPropertyCompletions(prefix)) {
        cssItems.push({
          label: property.label,
          kind: 10,
          detail: typeof property.detail === "string" ? property.detail : undefined,
          documentation: property.documentation ?? undefined,
          sortText: `5000:${property.label}`,
          textEdit: {
            range: model.embedded.toHostRange(start, localOffset),
            newText: property.label,
          },
        });
      }
    } else if (context.kind === "value") {
      for (const value of cssValueCompletions(context.property, prefix)) {
        cssItems.push({
          label: value.label,
          kind: 12,
          detail: value.detail,
          sortText: `5000:${value.label}`,
          textEdit: {
            range: model.embedded.toHostRange(start, localOffset),
            newText: value.label,
          },
        });
      }
    }
    const allItems = [...semanticItems, ...cssItems].sort((left, right) =>
      (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label),
    );
    const limit = Math.max(1, this.host.settings().completionLimit);
    return {
      isIncomplete: allItems.length > limit,
      items: /** @type {CompletionList["items"]} */ (allItems.slice(0, limit)),
    };
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<Hover | null>}
   */
  async hover(uri, position, signal = null) {
    const { item, symbols } = await this.host.symbolsAt(uri, position, signal);
    if (!item || item.type === "import" || !symbols.length) {
      return null;
    }
    const symbol = symbols[0];
    const declaration =
      symbol.signature ??
      (symbol.value !== null && symbol.value !== undefined
        ? `${symbol.name} = ${symbol.value}`
        : symbol.name);
    const details = [
      `\`\`\`stylus\n${declaration}\n\`\`\``,
      `**Kind:** ${symbol.kind}`,
      `**Defined in:** ${symbol.uri}`,
    ];
    if (symbol.uri !== uri) {
      details.push(`**Imported from:** ${symbol.uri}`);
    }
    if (symbol.documentation) {
      details.push(symbol.documentation);
    }
    return {
      contents: { kind: "markdown", value: details.join("\n\n") },
      range: item.type === "symbol" ? item.value.nameRange : item.value.range,
    };
  }

  /**
   * @param {string} uri
   * @param {Position} position
   * @param {CancellationSignal | null} signal
   * @returns {Promise<SignatureHelp | null>}
   */
  async signatureHelp(uri, position, signal = null) {
    const document = await this.host.getDocument(uri);
    const model = document ? this.host.modelAt(document, position) : null;
    if (!document || !model) {
      return null;
    }
    const hostOffset = model.embedded.hostLines.offsetAt(position);
    const localOffset = model.embedded.toLocalOffset(hostOffset);
    const call = model.references
      .filter(
        (reference) =>
          reference.role === "call" &&
          reference.localFullStart <= localOffset &&
          localOffset <= reference.localFullEnd,
      )
      .sort(
        (left, right) =>
          left.localFullEnd -
          left.localFullStart -
          (right.localFullEnd - right.localFullStart),
      )[0];
    let argumentsStart = call ? model.embedded.text.indexOf("(", call.localNameEnd) : -1;
    let symbols = call ? await this.host.resolveReference(model, call, signal) : [];

    if (!call) {
      let depth = 0;
      for (let offset = localOffset - 1; offset >= 0; offset -= 1) {
        const character = model.embedded.text[offset];
        if (character === ")") depth += 1;
        else if (character === "(") {
          if (depth > 0) {
            depth -= 1;
            continue;
          }
          argumentsStart = offset;
          const end = offset;
          let start = end;
          while (start > 0 && /[A-Za-z0-9_-]/.test(model.embedded.text[start - 1])) {
            start -= 1;
          }
          const name = model.embedded.text.slice(start, end);
          if (name) {
            symbols = model.resolveLocal(
              name,
              ["callable"],
              start,
              model.scopeAtLocalOffset(start)?.id,
            );
            if (!symbols.length) {
              symbols = await this.host.importedSymbols(model, name, ["callable"], signal);
            }
          }
          break;
        }
      }
    }
    if (!symbols.length || argumentsStart === -1) {
      return null;
    }
    const active = activeParameter(model.embedded.text, argumentsStart, localOffset);
    return {
      signatures: symbols.map((symbol) => ({
        label: symbol.signature ?? `${symbol.name}()`,
        documentation: symbol.documentation ?? undefined,
        parameters: (symbol.parameters ?? []).map((parameter) => ({
          label: `${parameter.name}${parameter.rest ? "..." : ""}${
            parameter.defaultValue !== null ? ` = ${parameter.defaultValue}` : ""
          }`,
        })),
      })),
      activeSignature: 0,
      activeParameter: Math.min(
        active,
        Math.max(0, (symbols[0].parameters?.length ?? 1) - 1),
      ),
    };
  }

  /** @param {string} uri @returns {Promise<ColorInformation[]>} */
  async documentColors(uri) {
    const document = await this.host.getDocument(uri);
    return document?.models.flatMap(colorInformation) ?? [];
  }

  /**
   * @param {Color} color
   * @param {Range} range
   * @returns {ColorPresentation[]}
   */
  colorPresentations(color, range) {
    return colorPresentations(color, range);
  }
}
