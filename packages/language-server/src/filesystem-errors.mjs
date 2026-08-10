/** @param {unknown} error @returns {string | null} */
export function fileSystemErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}

/** @param {unknown} error @returns {boolean} */
export function isMissingPathError(error) {
  const code = fileSystemErrorCode(error);
  return code !== null && ["ENOENT", "ENOTDIR"].includes(code);
}

/**
 * @param {string} action
 * @param {string} filePath
 * @param {unknown} error
 * @returns {string}
 */
export function fileSystemErrorMessage(action, filePath, error) {
  const code = fileSystemErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} '${filePath}'${code ? ` (${code})` : ""}: ${detail}`;
}

/**
 * Preserve the original error as `cause` while adding the operation and path
 * that an editor user needs to diagnose a filesystem failure.
 *
 * @param {string} action
 * @param {string} filePath
 * @param {unknown} error
 * @returns {Error}
 */
export function contextualFileSystemError(action, filePath, error) {
  return new Error(fileSystemErrorMessage(action, filePath, error), { cause: error });
}
