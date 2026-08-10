/**
 * Owns failure handling for work deliberately detached from an LSP notification.
 * Every task resolves after reporting its error, so no rejected Promise escapes
 * as an unhandled rejection.
 */
export class BackgroundTaskSupervisor {
  /** @param {(label: string, error: unknown) => void} reportError */
  constructor(reportError) {
    this.reportError = reportError;
  }

  /**
   * @param {string} label
   * @param {() => Promise<unknown> | unknown} task
   * @returns {Promise<void>}
   */
  run(label, task) {
    return Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (error) => {
          this.reportError(label, error);
        },
      );
  }
}
