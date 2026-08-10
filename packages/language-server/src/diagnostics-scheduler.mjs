/**
 * Debounce diagnostics and discard computations superseded by a newer request
 * for the same URI. Dependencies are injected so the scheduler is independent
 * of the LSP transport and can be tested deterministically.
 */
export class DiagnosticsScheduler {
  /**
   * @param {{
   *   openUris: () => string[],
   *   debounceMs: () => number,
   *   compute: (uri: string, signal: AbortSignal) => Promise<import("vscode-languageserver").Diagnostic[]>,
   *   publish: (params: import("vscode-languageserver").PublishDiagnosticsParams) => void,
   *   reportError: (uri: string, error: unknown) => void,
   *   versionForUri: (uri: string) => number | undefined
   * }} options
   */
  constructor({ openUris, debounceMs, compute, publish, reportError, versionForUri }) {
    this.openUris = openUris;
    this.debounceMs = debounceMs;
    this.compute = compute;
    this.publish = publish;
    this.reportError = reportError;
    this.versionForUri = versionForUri;
    this.generations = /** @type {Map<string, number>} */ (new Map());
    this.timers =
      /** @type {Map<string, {generation: number, timer: NodeJS.Timeout, controller: AbortController}>} */ (
        new Map()
      );
    this.sequence = 0;
  }

  /** @param {string} uri */
  #advance(uri) {
    const generation = ++this.sequence;
    this.generations.set(uri, generation);
    return generation;
  }

  /** @param {Iterable<string>} uris */
  schedule(uris) {
    const openUris = new Set(this.openUris());
    for (const uri of new Set(uris)) {
      if (!openUris.has(uri)) {
        continue;
      }
      const previous = this.timers.get(uri);
      if (previous) {
        clearTimeout(previous.timer);
        previous.controller.abort(new Error("Diagnostics superseded"));
      }
      const generation = this.#advance(uri);
      const version = this.versionForUri(uri);
      const controller = new AbortController();
      const timer = setTimeout(
        async () => {
          try {
            const diagnostics = await this.compute(uri, controller.signal);
            if (
              this.generations.get(uri) !== generation ||
              controller.signal.aborted ||
              !new Set(this.openUris()).has(uri)
            ) {
              return;
            }
            const params =
              /** @type {import("vscode-languageserver").PublishDiagnosticsParams} */ ({
                uri,
                diagnostics,
              });
            if (typeof version === "number") {
              params.version = version;
            }
            this.publish(params);
          } catch (error) {
            if (this.generations.get(uri) === generation) {
              this.reportError(uri, error);
            }
          } finally {
            if (this.timers.get(uri)?.generation === generation) {
              this.timers.delete(uri);
            }
          }
        },
        Math.max(0, this.debounceMs()),
      );
      this.timers.set(uri, { generation, timer, controller });
    }
  }

  /** @param {string} uri */
  cancel(uri) {
    this.generations.delete(uri);
    const pending = this.timers.get(uri);
    if (pending) {
      clearTimeout(pending.timer);
      pending.controller.abort(new Error("Diagnostics cancelled"));
      this.timers.delete(uri);
    }
  }
}
