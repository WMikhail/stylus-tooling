/** @typedef {import("./workspace-index.mjs").WorkspaceDocument} WorkspaceDocument */

/**
 * Owns host documents and unsaved overlays. Symbol-index updates and syntax-tree
 * disposal happen here so every insertion/removal follows the same lifecycle.
 */
export class WorkspaceDocumentStore {
  /** @param {import("./workspace-symbol-index.mjs").WorkspaceSymbolIndex} symbolIndex */
  constructor(symbolIndex) {
    this.symbolIndex = symbolIndex;
    this.documents = /** @type {Map<string, WorkspaceDocument>} */ (new Map());
    this.openTexts = /** @type {Map<string, string>} */ (new Map());
  }

  /** @param {string} uri */
  get(uri) {
    return this.documents.get(uri);
  }

  /** @param {string} uri */
  has(uri) {
    return this.documents.has(uri);
  }

  get size() {
    return this.documents.size;
  }

  keys() {
    return this.documents.keys();
  }

  values() {
    return this.documents.values();
  }

  entries() {
    return this.documents.entries();
  }

  /** @param {WorkspaceDocument} document */
  replace(document) {
    const previous = this.documents.get(document.uri);
    this.symbolIndex.removeDocument(previous);
    this.documents.set(document.uri, document);
    this.symbolIndex.addDocument(document);
    if (previous) {
      for (const model of previous.models) model.dispose();
    }
    return previous;
  }

  /** @param {string} uri */
  remove(uri) {
    const previous = this.documents.get(uri);
    if (!previous) return null;
    this.symbolIndex.removeDocument(previous);
    this.documents.delete(uri);
    for (const model of previous.models) model.dispose();
    return previous;
  }

  /** @param {string} uri @param {string} text */
  open(uri, text) {
    this.openTexts.set(uri, text);
  }

  /** @param {string} uri */
  close(uri) {
    this.openTexts.delete(uri);
  }

  /** @param {string} uri */
  openText(uri) {
    return this.openTexts.get(uri);
  }

  /** @param {string} uri */
  isOpen(uri) {
    return this.openTexts.has(uri);
  }

  openUris() {
    return [...this.openTexts.keys()];
  }

  documentUris() {
    return [...this.documents.keys()];
  }
}
