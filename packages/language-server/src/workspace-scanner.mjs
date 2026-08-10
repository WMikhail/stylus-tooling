import { promises as fs } from "node:fs";
import path from "node:path";

import createIgnore from "ignore";

import { fileSystemErrorMessage, isMissingPathError } from "./filesystem-errors.mjs";
import { safeMinimatch } from "./glob-utils.mjs";

const SOURCE_EXTENSIONS = new Set([".styl", ".stylus", ".vue", ".svelte", ".astro"]);

/** @param {string} filePath @returns {boolean} */
export function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * @template T
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T, index: number) => Promise<unknown> | unknown} callback
 */
export async function mapWithConcurrency(values, concurrency, callback) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, values.length)) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await callback(values[index], index);
      }
    },
  );
  await Promise.all(workers);
}

/** @param {string} rootPath */
export async function readRootIgnore(rootPath) {
  const matcher = createIgnore();
  const messages = [];
  try {
    matcher.add(await fs.readFile(path.join(rootPath, ".gitignore"), "utf8"));
  } catch (error) {
    if (!isMissingPathError(error)) {
      messages.push(
        fileSystemErrorMessage(
          "Unable to read workspace ignore file",
          path.join(rootPath, ".gitignore"),
          error,
        ),
      );
    }
  }
  return { matcher, messages };
}

/**
 * @param {string} rootPath
 * @param {import("./workspace-settings.mjs").WorkspaceSettings} settings
 * @param {{readonly aborted: boolean, readonly reason?: unknown} | null} signal
 * @returns {Promise<{files: string[], messages: string[], truncated: boolean}>}
 */
export async function collectSourceFiles(rootPath, settings, signal = null) {
  const result = [];
  const ignoreResult = await readRootIgnore(rootPath);
  const ignored = ignoreResult.matcher;
  const messages = [...ignoreResult.messages];
  const queue = [{ directory: rootPath, depth: 0 }];
  let cursor = 0;
  let directories = 0;
  let entriesSeen = 0;
  let truncated = false;
  let limitMessage = null;
  while (cursor < queue.length) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Workspace indexing cancelled");
    }
    const { directory, depth } = queue[cursor++];
    directories += 1;
    if (directories > settings.maxWorkspaceDirectories) {
      truncated = true;
      limitMessage = `Workspace scan stopped after ${settings.maxWorkspaceDirectories} directories.`;
      break;
    }
    const entries = [];
    try {
      const handle = await fs.opendir(directory);
      for await (const entry of handle) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Workspace indexing cancelled");
        }
        entriesSeen += 1;
        if (entriesSeen > settings.maxWorkspaceEntries) {
          truncated = true;
          limitMessage = `Workspace scan stopped after ${settings.maxWorkspaceEntries} filesystem entries.`;
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isMissingPathError(error)) {
        messages.push(
          fileSystemErrorMessage("Unable to scan workspace directory", directory, error),
        );
      }
      continue;
    }
    if (truncated) break;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(rootPath, entryPath).replaceAll(path.sep, "/");
      const matchPath = entry.isDirectory() ? `${relative}/` : relative;
      const excluded = settings.exclude.some((pattern) =>
        safeMinimatch(matchPath, pattern, {
          maxBraceExpansions: settings.maxBraceExpansions,
        }),
      );
      const gitignored = relative && ignored.ignores(matchPath);
      if (entry.isDirectory()) {
        if (!excluded && !gitignored) {
          if (depth >= settings.maxWorkspaceDepth) {
            truncated = true;
            limitMessage ??= `Workspace scan skipped directories deeper than ${settings.maxWorkspaceDepth} levels.`;
          } else {
            queue.push({ directory: entryPath, depth: depth + 1 });
          }
        }
      } else if (entry.isFile() && !excluded && !gitignored && isSourceFile(entryPath)) {
        if (result.length >= settings.maxWorkspaceFiles) {
          truncated = true;
          limitMessage = `Workspace scan stopped after ${settings.maxWorkspaceFiles} source files.`;
          break;
        }
        result.push(entryPath);
      }
    }
    if (result.length >= settings.maxWorkspaceFiles) break;
  }
  if (limitMessage) {
    messages.push(`${limitMessage} Narrow the workspace or adjust Stylus scan limits.`);
  }
  return { files: result, messages, truncated };
}
