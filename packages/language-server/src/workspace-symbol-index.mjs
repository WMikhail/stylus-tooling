/** @typedef {import("./semantic-model.mjs").SemanticModel} SemanticModel */
/** @typedef {import("./semantic-model.mjs").SemanticSymbol} SemanticSymbol */
/** @typedef {{models: SemanticModel[]}} SymbolDocument */

export class WorkspaceSymbolIndex {
  constructor() {
    this.byName = /** @type {Map<string, SemanticSymbol[]>} */ (new Map());
    this.byId = /** @type {Map<string, SemanticSymbol>} */ (new Map());
  }

  /** @param {SymbolDocument | null | undefined} document */
  removeDocument(document) {
    if (!document) {
      return;
    }
    for (const model of document.models) {
      for (const symbol of model.symbols) {
        this.byId.delete(symbol.id);
        const remaining = (this.byName.get(symbol.name) ?? []).filter(
          (candidate) => candidate.id !== symbol.id,
        );
        if (remaining.length) {
          this.byName.set(symbol.name, remaining);
        } else {
          this.byName.delete(symbol.name);
        }
      }
    }
  }

  /** @param {SymbolDocument} document */
  addDocument(document) {
    for (const model of document.models) {
      for (const symbol of model.symbols) {
        this.byId.set(symbol.id, symbol);
        const entries = this.byName.get(symbol.name) ?? [];
        entries.push(symbol);
        entries.sort(
          (left, right) =>
            left.uri.localeCompare(right.uri) ||
            left.nameRange.start.line - right.nameRange.start.line ||
            left.nameRange.start.character - right.nameRange.start.character,
        );
        this.byName.set(symbol.name, entries);
      }
    }
  }

  /** @param {string} name @returns {SemanticSymbol[]} */
  named(name) {
    return this.byName.get(name) ?? [];
  }

  /** @returns {MapIterator<SemanticSymbol>} */
  values() {
    return this.byId.values();
  }

  get size() {
    return this.byId.size;
  }
}
