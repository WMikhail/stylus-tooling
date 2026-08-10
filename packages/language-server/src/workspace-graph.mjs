/**
 * @typedef {{
 *   uri: string,
 *   importId: string | null,
 *   embeddedUri: string,
 *   order: number,
 *   via: string
 * }} ImportEdge
 */

export class WorkspaceGraph {
  constructor() {
    this.edgesByUri = /** @type {Map<string, ImportEdge[]>} */ (new Map());
    this.reverseDependencies = /** @type {Map<string, Set<string>>} */ (new Map());
  }

  /** @param {string} uri @returns {ImportEdge[]} */
  edgesFrom(uri) {
    return this.edgesByUri.get(uri) ?? [];
  }

  /** @param {string} uri @returns {Set<string>} */
  dependentsOf(uri) {
    return this.reverseDependencies.get(uri) ?? new Set();
  }

  /** @param {string} uri */
  removeEdges(uri) {
    for (const edge of this.edgesFrom(uri)) {
      const reverse = this.reverseDependencies.get(edge.uri);
      reverse?.delete(uri);
      if (reverse?.size === 0) {
        this.reverseDependencies.delete(edge.uri);
      }
    }
    this.edgesByUri.delete(uri);
  }

  /** @param {string} uri @param {ImportEdge[]} edges */
  replaceEdges(uri, edges) {
    this.removeEdges(uri);
    this.edgesByUri.set(uri, edges);
    for (const edge of edges) {
      const reverse = this.reverseDependencies.get(edge.uri) ?? new Set();
      reverse.add(uri);
      this.reverseDependencies.set(edge.uri, reverse);
    }
  }

  /** @param {string} uri @returns {Set<string>} */
  affectedUris(uri) {
    const affected = new Set([uri]);
    const queue = [uri];
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      for (const dependent of this.dependentsOf(current)) {
        if (!affected.has(dependent)) {
          affected.add(dependent);
          queue.push(dependent);
        }
      }
    }
    return affected;
  }

  /**
   * @param {string} fromUri
   * @param {string} targetUri
   * @param {number} maxDepth
   * @param {Set<string>} visited
   * @param {number} depth
   * @returns {boolean}
   */
  canReach(fromUri, targetUri, maxDepth, visited = new Set(), depth = 0) {
    if (fromUri === targetUri) {
      return true;
    }
    if (visited.has(fromUri) || depth >= maxDepth) {
      return false;
    }
    visited.add(fromUri);
    return this.edgesFrom(fromUri).some((edge) =>
      this.canReach(edge.uri, targetUri, maxDepth, visited, depth + 1),
    );
  }

  /** @param {string} uri @param {number} maxDepth @returns {Set<string>} */
  cyclicImportIds(uri, maxDepth) {
    /** @type {Set<string>} */
    const result = new Set();
    for (const edge of this.edgesFrom(uri)) {
      if (edge.importId !== null && this.canReach(edge.uri, uri, maxDepth)) {
        result.add(edge.importId);
      }
    }
    return result;
  }

  get size() {
    let count = 0;
    for (const edges of this.edgesByUri.values()) {
      count += edges.length;
    }
    return count;
  }
}
