import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isSafeGlobPattern, safeMinimatch } from "../src/glob-utils.mjs";
import { ImportResolver } from "../src/import-resolver.mjs";

async function write(root, relative, text = "") {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
  return filePath;
}

test("bounds brace expansion before invoking minimatch", () => {
  assert.equal(isSafeGlobPattern("styles/*.{styl,stylus}"), true);
  assert.equal(safeMinimatch("styles/main.styl", "styles/*.{styl,stylus}"), true);
  assert.equal(isSafeGlobPattern("styles/{1..100000000}.styl"), false);
  assert.equal(isSafeGlobPattern("styles/{a,{b,c}}.styl"), false);
  assert.equal(safeMinimatch("styles/main.styl", "styles/{1..100000000}.styl"), false);
});

test("keeps relative glob traversal inside the workspace", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-safe-glob-"));
  const root = path.join(parent, "project");
  const importer = await write(root, "src/main.styl");
  await write(parent, "outside/secret.styl", "$secret = red\n");
  const resolver = new ImportResolver({ rootPaths: [root] });

  assert.deepEqual(await resolver.resolve("../../outside/*.styl", importer), []);
});

test("applies directory and match budgets while resolving globs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-glob-budget-"));
  const importer = await write(root, "src/main.styl");
  await write(root, "src/partials/a.styl");
  await write(root, "src/partials/nested/b.styl");
  const resolver = new ImportResolver({ rootPaths: [root] });
  resolver.configure({ maxGlobMatches: 1, maxGlobDirectories: 1 });

  const resolved = await resolver.resolve("./partials/**/*.styl", importer);
  assert.equal(resolved.length, 1);
  assert.equal(path.basename(resolved[0].filePath), "a.styl");
});
