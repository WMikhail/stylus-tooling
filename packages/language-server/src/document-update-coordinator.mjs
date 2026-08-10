/** @typedef {{readonly aborted: boolean, readonly reason?: unknown}} CancellationSignal */

class SupersededDocumentUpdate extends Error {
  constructor() {
    super("Document update superseded by newer text");
    this.name = "SupersededDocumentUpdate";
  }
}

/** Serializes per-document work, cancels superseded parsing, and deduplicates file loads. */
export class DocumentUpdateCoordinator {
  constructor() {
    this.documentVersions = /** @type {Map<string, number>} */ (new Map());
    this.pendingDocuments = /** @type {Map<string, Promise<unknown>>} */ (new Map());
    this.documentTails = /** @type {Map<string, Promise<void>>} */ (new Map());
    this.documentControllers = /** @type {Map<string, AbortController>} */ (new Map());
    this.scheduledVersions = /** @type {Map<string, number>} */ (new Map());
    this.indexingPaths = /** @type {Map<string, Promise<unknown>>} */ (new Map());
  }

  /** @param {string} uri */
  nextDocumentVersion(uri) {
    const version = (this.documentVersions.get(uri) ?? 0) + 1;
    this.documentVersions.set(uri, version);
    return version;
  }

  /** @param {string} uri @param {number} version */
  isCurrentDocumentVersion(uri, version) {
    return this.documentVersions.get(uri) === version;
  }

  /** @param {string} uri */
  pending(uri) {
    return this.pendingDocuments.get(uri);
  }

  /**
   * @template T
   * @param {string} uri
   * @param {CancellationSignal | null} signal
   * @param {() => T} current
   * @param {(signal: CancellationSignal) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async schedule(uri, signal, current, callback) {
    const scheduledVersion = (this.scheduledVersions.get(uri) ?? 0) + 1;
    this.scheduledVersions.set(uri, scheduledVersion);
    this.documentControllers.get(uri)?.abort(new SupersededDocumentUpdate());
    const controller = new AbortController();
    this.documentControllers.set(uri, controller);
    const previousTail = this.documentTails.get(uri) ?? Promise.resolve();
    const combinedSignal = {
      get aborted() {
        return controller.signal.aborted || Boolean(signal?.aborted);
      },
      get reason() {
        return controller.signal.aborted ? controller.signal.reason : signal?.reason;
      },
    };
    const operation = previousTail
      .catch(() => undefined)
      .then(async () => {
        if (this.scheduledVersions.get(uri) !== scheduledVersion) return current();
        try {
          return await callback(combinedSignal);
        } catch (error) {
          if (
            controller.signal.aborted &&
            controller.signal.reason instanceof SupersededDocumentUpdate
          ) {
            return current();
          }
          throw error;
        }
      });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.documentTails.set(uri, tail);
    this.pendingDocuments.set(uri, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingDocuments.get(uri) === operation) this.pendingDocuments.delete(uri);
      if (this.documentTails.get(uri) === tail) this.documentTails.delete(uri);
      if (this.documentControllers.get(uri) === controller) {
        this.documentControllers.delete(uri);
      }
    }
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async deduplicateFile(key, callback) {
    const existing = this.indexingPaths.get(key);
    if (existing) return /** @type {Promise<T>} */ (existing);
    const operation = callback();
    this.indexingPaths.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.indexingPaths.get(key) === operation) this.indexingPaths.delete(key);
    }
  }
}
