/** @typedef {import("./semantic-model.mjs").SemanticSymbol} SemanticSymbol */

/** Tracks resolution promises and the documents/workspace state that invalidate them. */
export class ResolutionCache {
  constructor() {
    this.cache = /** @type {Map<string, Promise<SemanticSymbol[]>>} */ (new Map());
    this.keysByUri = /** @type {Map<string, Set<string>>} */ (new Map());
    this.workspaceKeys = /** @type {Set<string>} */ (new Set());
  }

  clear() {
    this.cache.clear();
    this.keysByUri.clear();
    this.workspaceKeys.clear();
  }

  clearWorkspace() {
    for (const key of this.workspaceKeys) this.cache.delete(key);
    this.workspaceKeys.clear();
    this.#removeUncachedKeys();
  }

  /** @param {Iterable<string>} uris */
  invalidate(uris) {
    for (const uri of uris) {
      for (const key of this.keysByUri.get(uri) ?? []) {
        this.cache.delete(key);
        this.workspaceKeys.delete(key);
      }
      this.keysByUri.delete(uri);
    }
  }

  /** @param {string} key */
  get(key) {
    return this.cache.get(key);
  }

  /**
   * @param {string} key
   * @param {string} uri
   * @param {boolean} workspace
   * @param {Promise<SemanticSymbol[]>} operation
   */
  track(key, uri, workspace, operation) {
    const tracked = operation.catch((error) => {
      this.#delete(key, uri);
      throw error;
    });
    this.cache.set(key, tracked);
    if (workspace) this.workspaceKeys.add(key);
    const keys = this.keysByUri.get(uri) ?? new Set();
    keys.add(key);
    this.keysByUri.set(uri, keys);
    return tracked;
  }

  /** @param {string} key @param {string} uri */
  #delete(key, uri) {
    this.cache.delete(key);
    this.workspaceKeys.delete(key);
    const keys = this.keysByUri.get(uri);
    keys?.delete(key);
    if (keys?.size === 0) this.keysByUri.delete(uri);
  }

  #removeUncachedKeys() {
    for (const [uri, keys] of this.keysByUri) {
      for (const key of keys) {
        if (!this.cache.has(key)) keys.delete(key);
      }
      if (keys.size === 0) this.keysByUri.delete(uri);
    }
  }
}
