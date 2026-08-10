import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectSourceFiles } from "../src/workspace-scanner.mjs";
import { createWorkspaceSettings } from "../src/workspace-settings.mjs";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-workspace-scan-"));
}

async function write(root, relative, text = "") {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
  return filePath;
}

test("bounds workspace scanning and reports a visible truncation message", async () => {
  const root = await workspace();
  await write(root, "a.styl");
  await write(root, "b.styl");
  await write(root, "c.styl");

  const result = await collectSourceFiles(
    root,
    createWorkspaceSettings({ maxWorkspaceFiles: 2 }),
  );

  assert.equal(result.files.length, 2);
  assert.equal(result.truncated, true);
  assert.ok(
    result.messages.some((message) => /stopped after 2 source files/.test(message)),
  );
});

test("checks cancellation while streaming directory entries", async () => {
  const root = await workspace();
  await write(root, "main.styl");
  const reason = new Error("cancelled scan");

  await assert.rejects(
    collectSourceFiles(root, createWorkspaceSettings(), {
      aborted: true,
      reason,
    }),
    reason,
  );
});
