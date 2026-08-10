import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri, LineMap } from "../src/protocol.mjs";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-authoring-"));
}

async function write(root, relative, text) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
  return filePath;
}

function positionOf(text, needle, occurrence = 0, inset = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = text.indexOf(needle, offset + 1);
  }
  assert.notEqual(offset, -1);
  return new LineMap(text).positionAt(offset + inset);
}

test("completion ranks lexical and imported symbols and uses standard CSS data", async () => {
  const root = await workspace();
  await write(root, "tokens.styl", `$bg-theme = #123456\n$bg-other = #ffffff\n`);
  const source = `@import "./tokens"
$bg-local = #000000
.card
  color $bg-
  backgr
  display fl
`;
  const sourcePath = await write(root, "main.styl", source);
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const variables = await index.completion(
    uri,
    positionOf(source, "$bg-", 1, "$bg-".length),
  );
  assert.deepEqual(
    variables.items.slice(0, 3).map((item) => item.label),
    ["$bg-local", "$bg-other", "$bg-theme"],
  );
  assert.ok(variables.items[0].sortText < variables.items[1].sortText);

  const properties = await index.completion(
    uri,
    positionOf(source, "backgr", 0, "backgr".length),
  );
  assert.ok(properties.items.some((item) => item.label === "background"));

  const values = await index.completion(
    uri,
    positionOf(source, "display fl", 0, "display fl".length),
  );
  assert.ok(values.items.some((item) => item.label === "flex"));
});

test("import completion returns real files", async () => {
  const root = await workspace();
  await write(root, "tokens.styl", "$x = red\n");
  const source = `@import "./to"\n`;
  const sourcePath = await write(root, "main.styl", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const completion = await index.completion(
    filePathToUri(sourcePath),
    positionOf(source, "./to", 0, 4),
  );
  assert.ok(completion.items.some((item) => item.label === "./tokens.styl"));

  const afterQuote = await index.completion(
    filePathToUri(sourcePath),
    new LineMap(source).positionAt(source.indexOf("\n")),
  );
  const completed = afterQuote.items.find((item) => item.label === "./tokens.styl");
  assert.ok(completed);
  const lines = new LineMap(source);
  const editStart = lines.offsetAt(completed.textEdit.range.start);
  const editEnd = lines.offsetAt(completed.textEdit.range.end);
  assert.equal(
    `${source.slice(0, editStart)}${completed.textEdit.newText}${source.slice(editEnd)}`,
    `@import "./tokens.styl"\n`,
  );
});

test("bounds import completion and marks truncated results as incomplete", async () => {
  const root = await workspace();
  for (const name of ["a", "b", "c", "d"]) {
    await write(root, `${name}.styl`, `$${name} = red\n`);
  }
  const source = `@import "./"\n`;
  const sourcePath = await write(root, "main.styl", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  index.configure({ stylus: { completionLimit: 2 } });
  await index.rebuild();

  const completion = await index.completion(
    filePathToUri(sourcePath),
    positionOf(source, "./", 0, 2),
  );
  assert.equal(completion.items.length, 2);
  assert.equal(completion.isIncomplete, true);
});

test("hover reports static values, documentation, definition, and import origin", async () => {
  const root = await workspace();
  const tokens = `// Primary surface color
$surface = #f6f6f6
`;
  await write(root, "tokens.styl", tokens);
  const source = `@require "./tokens"\n.card\n  color $surface\n`;
  const sourcePath = await write(root, "main.styl", source);
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const hover = await index.hover(uri, positionOf(source, "$surface", 0, 3));
  assert.match(hover.contents.value, /\$surface = #f6f6f6/);
  assert.match(hover.contents.value, /Primary surface color/);
  assert.match(hover.contents.value, /Imported from/);
});

test("signature help selects parameters in nested calls", async () => {
  const root = await workspace();
  const source = `mix($a, $b = 2, $c = 3)
  return $a + $b + $c
nested($x, $y)
  return $x + $y
.card
  width mix(1, nested(2, 3), 4)
`;
  const sourcePath = await write(root, "main.styl", source);
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const outer = await index.signatureHelp(uri, positionOf(source, ", 4)", 0, 2));
  assert.equal(outer.signatures[0].label, "mix($a, $b = 2, $c = 3)");
  assert.equal(outer.activeParameter, 2);

  const inner = await index.signatureHelp(uri, positionOf(source, "2, 3", 0, 4));
  assert.equal(inner.signatures[0].label, "nested($x, $y)");
  assert.equal(inner.activeParameter, 1);
});

test("color provider maps literals in Vue and offers replacement forms", async () => {
  const root = await workspace();
  const source = `<template>😀</template>
<style lang="stylus">
.card
  color #369
  background rgba(255, 0, 0, .5)
  border-color hsl(120, 100%, 25%)
  outline-color rgb(foo, bar, baz)
  text-decoration-color hsl(90, nope, 10%)
</style>`;
  const sourcePath = await write(root, "Card.vue", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const colors = await index.documentColors(filePathToUri(sourcePath));
  assert.equal(colors.length, 3);
  assert.ok(
    colors.every((entry) =>
      Object.values(entry.color).every((value) => Number.isFinite(value)),
    ),
  );
  assert.deepEqual(colors[0].color, {
    red: 0.2,
    green: 0.4,
    blue: 0.6,
    alpha: 1,
  });
  assert.equal(new LineMap(source).offsetAt(colors[0].range.start), source.indexOf("#369"));

  const presentations = index.colorPresentations(colors[1].color, colors[1].range);
  assert.equal(presentations.length, 3);
  assert.match(presentations[0].label, /^#[0-9a-f]{8}$/);
  assert.match(presentations[1].label, /^rgba\(/);
  assert.match(presentations[2].label, /^hsla\(/);
});
