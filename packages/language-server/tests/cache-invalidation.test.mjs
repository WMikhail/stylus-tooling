import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { filePathToUri, WorkspaceIndex } from "../src/workspace-index.mjs";

test("invalidates dependent resolutions without reparsing dependent syntax trees", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-cache-invalidation-"));
  const tokenPath = path.join(root, "tokens.styl");
  await fs.writeFile(tokenPath, "$token = red\n");

  const usageUris = [];
  for (let index = 0; index < 32; index += 1) {
    const usagePath = path.join(root, `usage-${index}.styl`);
    await fs.writeFile(usagePath, `@import "./tokens"\n.item-${index}\n  color $token\n`);
    usageUris.push(filePathToUri(usagePath));
  }

  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  for (const uri of usageUris) {
    assert.ok(await index.definition(uri, { line: 2, character: 10 }));
  }

  const before = index.snapshotMetrics();
  const tokenUri = filePathToUri(tokenPath);
  await index.openDocument(tokenUri, "$brand = blue\n");
  const afterSharedChange = index.snapshotMetrics();

  assert.equal(afterSharedChange.parsedDocuments - before.parsedDocuments, 1);
  assert.equal(afterSharedChange.incrementalParses - before.incrementalParses, 1);
  assert.equal(afterSharedChange.syntaxTrees, before.syntaxTrees);
  assert.equal(index.affectedUris(tokenUri).length, usageUris.length + 1);
  for (const uri of usageUris) {
    assert.equal(await index.definition(uri, { line: 2, character: 10 }), null);
  }

  const beforeRapidChanges = index.snapshotMetrics();
  await Promise.all([
    index.changeDocument(tokenUri, "$first = red\n"),
    index.changeDocument(tokenUri, "$second = red\n"),
    index.changeDocument(tokenUri, "$final = red\n"),
  ]);
  const afterRapidChanges = index.snapshotMetrics();

  assert.equal(afterRapidChanges.parsedDocuments - beforeRapidChanges.parsedDocuments, 1);
  assert.equal(
    afterRapidChanges.incrementalParses - beforeRapidChanges.incrementalParses,
    1,
  );
  assert.deepEqual(
    (await index.workspaceSymbols("$final")).map((symbol) => symbol.name),
    ["$final"],
  );
  assert.deepEqual(await index.workspaceSymbols("$first"), []);
  assert.deepEqual(await index.workspaceSymbols("$second"), []);
});

test("invalidates cached workspace fallbacks when unrelated symbols change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-workspace-cache-"));
  const firstPath = path.join(root, "first.styl");
  const secondPath = path.join(root, "second.styl");
  const usagePath = path.join(root, "usage.styl");
  await fs.writeFile(firstPath, "$shared = red\n");
  await fs.writeFile(secondPath, "$other = blue\n");
  await fs.writeFile(usagePath, ".usage\n  color $shared\n");

  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const usageUri = filePathToUri(usagePath);
  const position = { line: 1, character: 10 };
  assert.equal((await index.definition(usageUri, position)).uri, filePathToUri(firstPath));

  const secondUri = filePathToUri(secondPath);
  await index.openDocument(secondUri, "$shared = blue\n");
  const ambiguous = await index.definition(usageUri, position);
  assert.deepEqual(
    new Set(ambiguous.map((location) => location.uri)),
    new Set([filePathToUri(firstPath), secondUri]),
  );

  await index.changeDocument(secondUri, "$other = blue\n");
  assert.equal((await index.definition(usageUri, position)).uri, filePathToUri(firstPath));
});
