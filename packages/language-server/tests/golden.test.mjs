import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri, LineMap } from "../src/protocol.mjs";

const EXPECTED_PATH = fileURLToPath(new URL("golden/core.json", import.meta.url));

function positionOf(text, needle, occurrence = 0, inset = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = text.indexOf(needle, offset + 1);
  }
  return new LineMap(text).positionAt(offset + inset);
}

function stable(value, replacements) {
  if (Array.isArray(value)) return value.map((entry) => stable(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [stable(key, replacements), stable(entry, replacements)]),
    );
  }
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of replacements) result = result.replaceAll(from, to);
    return result;
  }
  return value;
}

test("golden LSP responses remain stable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-golden-"));
  const tokens = `// Shared brand color
$brand = #123456
add($a, $b)
  return $a + $b
`;
  await fs.writeFile(path.join(root, "tokens.styl"), tokens);
  const source = `<template><div/></template>
<style lang="stylus" scoped>
@import "./tokens"
$local = #fff
.card
  color $brand
  width add(1, 2)
  background $lo
  border-color #369
  outline-color $missing
</style>`;
  const sourcePath = path.join(root, "Card.vue");
  await fs.writeFile(sourcePath, source);
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const actual = {
    definition: await index.definition(uri, positionOf(source, "$brand", 0, 3)),
    references: await index.references(uri, positionOf(source, "$brand", 0, 3), true),
    prepareRename: await index.prepareRename(uri, positionOf(source, "$brand", 0, 3)),
    rename: await index.rename(uri, positionOf(source, "$brand", 0, 3), "$primary"),
    documentSymbols: await index.documentSymbols(uri),
    workspaceSymbols: await index.workspaceSymbols("brand"),
    completion: await index.completion(uri, positionOf(source, "$lo", 0, "$lo".length)),
    hover: await index.hover(uri, positionOf(source, "$brand", 0, 3)),
    signatureHelp: await index.signatureHelp(uri, positionOf(source, "1, 2", 0, 3)),
    colors: await index.documentColors(uri),
    diagnostics: await index.diagnostics(uri),
  };
  const normalized = stable(actual, [
    [filePathToUri(root), "file://<ROOT>"],
    [root, "<ROOT>"],
  ]);
  if (process.env.PRINT_STYLUS_GOLDEN === "1") {
    console.log(JSON.stringify(normalized, null, 2));
    return;
  }
  const expected = JSON.parse(await fs.readFile(EXPECTED_PATH, "utf8"));
  assert.deepEqual(normalized, expected);
});
