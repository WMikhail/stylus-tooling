import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../src/diagnostics.mjs";
import { RenameError, WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri, LineMap } from "../src/protocol.mjs";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-navigation-"));
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
  assert.notEqual(offset, -1, `fixture is missing ${needle}`);
  return new LineMap(text).positionAt(offset + inset);
}

function asLocations(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

test("definition resolves semantic symbol kinds, imports, scopes, and chains", async () => {
  const root = await workspace();
  const library = `$global = red
sum($a, $b)
  return $a + $b
paint($tone)
  color $tone
$base
  color red
@keyframes spin
  from
    opacity 0
`;
  const libraryPath = await write(root, "styles/library.stylus", library);
  await write(root, "styles/index.styl", `@require "./library"\n`);
  const usage = `@import "./styles"
.card
  width sum(1, 2)
  paint(blue)
  color $global
  @extend $base
  animation spin 1s
items = 1
each item, index in items
  order index
  width item
`;
  const usagePath = await write(root, "main.styl", usage);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const usageUri = filePathToUri(usagePath);
  const libraryUri = filePathToUri(libraryPath);

  for (const [needle, occurrence] of [
    ["sum", 0],
    ["paint", 0],
    ["$global", 0],
    ["$base", 0],
    ["spin", 0],
  ]) {
    const definition = await index.definition(
      usageUri,
      positionOf(usage, needle, occurrence, 1),
    );
    assert.equal(
      asLocations(definition)[0].uri,
      libraryUri,
      `${needle} should cross imports`,
    );
  }

  const importedFile = await index.definition(
    usageUri,
    positionOf(usage, "./styles", 0, 2),
  );
  assert.equal(
    asLocations(importedFile)[0].uri,
    filePathToUri(path.join(root, "styles/index.styl")),
  );

  for (const needle of ["index", "item"]) {
    const usageOccurrence = needle === "item" ? 3 : 1;
    const definition = await index.definition(
      usageUri,
      positionOf(usage, needle, usageOccurrence, 1),
    );
    assert.equal(asLocations(definition)[0].uri, usageUri);
    assert.equal(asLocations(definition)[0].range.start.line, 8);
  }
});

test("resolves implicit-return functions and animation variables separately from keyframes", async () => {
  const root = await workspace();
  const source = `double(value)
  value * 2
$duration = 1s
@keyframes spin
  from
    opacity 0
.card
  width double(3px)
  animation spin $duration ease-in infinite forwards
`;
  const sourcePath = await write(root, "main.styl", source);
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  for (const [needle, occurrence, expectedLine] of [
    ["double", 1, 0],
    ["spin", 1, 3],
    ["$duration", 1, 2],
  ]) {
    const definition = await index.definition(
      uri,
      positionOf(source, needle, occurrence, 1),
    );
    assert.equal(asLocations(definition)[0]?.uri, uri);
    assert.equal(asLocations(definition)[0]?.range.start.line, expectedLine);
  }
});

test("references and rename preserve shadowing across Stylus and Vue", async () => {
  const root = await workspace();
  const tokens = `$shared = red
$other = blue
`;
  const tokensPath = await write(root, "tokens.styl", tokens);
  const standalone = `@import "./tokens"
.outside
  color $shared
.inside
  $shared = local
  color $shared
`;
  const standalonePath = await write(root, "usage.stylus", standalone);
  const vue = `<template><div/></template>
<style lang="stylus" scoped>
@require "./tokens"
.card
  color $shared
</style>`;
  const vuePath = await write(root, "Card.vue", vue);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const tokensUri = filePathToUri(tokensPath);
  const references = await index.references(
    tokensUri,
    positionOf(tokens, "$shared", 0, 2),
    true,
  );
  assert.deepEqual(
    references.map((location) => location.uri),
    [filePathToUri(vuePath), tokensUri, filePathToUri(standalonePath)].sort(),
  );
  assert.equal(
    references.filter((location) => location.uri === filePathToUri(standalonePath)).length,
    1,
    "the shadowed usage must not be attributed to the imported definition",
  );

  const prepared = await index.prepareRename(
    filePathToUri(vuePath),
    positionOf(vue, "$shared", 0, 3),
  );
  assert.equal(prepared.placeholder, "$shared");
  assert.equal(
    vue.slice(
      new LineMap(vue).offsetAt(prepared.range.start),
      new LineMap(vue).offsetAt(prepared.range.end),
    ),
    "$shared",
  );

  const edit = await index.rename(tokensUri, positionOf(tokens, "$shared", 0, 2), "$brand");
  assert.equal(edit.changes[tokensUri].length, 1);
  assert.equal(edit.changes[filePathToUri(vuePath)].length, 1);
  assert.equal(edit.changes[filePathToUri(standalonePath)].length, 1);

  await assert.rejects(
    index.rename(tokensUri, positionOf(tokens, "$shared", 0, 2), "$other"),
    (error) => error instanceof RenameError && /conflict/.test(error.message),
  );
  await assert.rejects(
    index.rename(tokensUri, positionOf(tokens, "$shared", 0, 2), "not valid!"),
    (error) => error instanceof RenameError && /not a valid/.test(error.message),
  );
});

test("keeps imports isolated between embedded Stylus style blocks", async () => {
  const root = await workspace();
  await write(root, "tokens.styl", "$token = red\n");
  const component = `<style lang="stylus">
@import "./tokens"
.first
  color $token
</style>
<style lang="stylus">
.second
  color $token
</style>
`;
  const componentPath = await write(root, "Component.vue", component);
  const componentUri = filePathToUri(componentPath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const unknownVariables = (await index.diagnostics(componentUri)).filter(
    (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
  );
  assert.deepEqual(
    unknownVariables.map((diagnostic) => diagnostic.range.start.line),
    [7],
  );

  const secondCompletion = await index.completion(
    componentUri,
    positionOf(component, "$token", 1, "$token".length),
  );
  assert.ok(!secondCompletion.items.some((item) => item.label === "$token"));
});

test("waits for pending imported document changes before resolving symbols", async () => {
  const root = await workspace();
  const tokensPath = await write(root, "tokens.styl", "$old = red\n");
  const usage = `@import "./tokens"\n.usage\n  color $new\n`;
  const usagePath = await write(root, "usage.styl", usage);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const pendingChange = index.changeDocument(filePathToUri(tokensPath), "$new = blue\n");
  const definition = await index.definition(
    filePathToUri(usagePath),
    positionOf(usage, "$new", 0, 2),
  );
  await pendingChange;

  assert.equal(asLocations(definition)[0]?.uri, filePathToUri(tokensPath));
});

test("keeps diagnostics and workspace-fallback references independent", async () => {
  const root = await workspace();
  const definitionPath = await write(root, "tokens.styl", `$only = red\n`);
  const usage = `.usage\n  color $only\n`;
  const usagePath = await write(root, "usage.styl", usage);
  const usageUri = filePathToUri(usagePath);
  const position = positionOf(usage, "$only", 0, 2);

  for (const diagnosticsFirst of [true, false]) {
    const index = new WorkspaceIndex([filePathToUri(root)]);
    await index.rebuild();
    let diagnostics;
    let references;
    if (diagnosticsFirst) {
      diagnostics = await index.diagnostics(usageUri);
      references = await index.references(usageUri, position, true);
    } else {
      references = await index.references(usageUri, position, true);
      diagnostics = await index.diagnostics(usageUri);
    }
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
      ),
    );
    assert.deepEqual(
      new Set(references.map((location) => location.uri)),
      new Set([filePathToUri(definitionPath), usageUri]),
    );
  }
});

test("document/workspace symbols and file lifecycle updates are deterministic", async () => {
  const root = await workspace();
  const source = `$token = red
paint($value)
  color $value
.card
  color $token
`;
  const sourcePath = await write(root, "main.styl", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const documentSymbols = await index.documentSymbols(filePathToUri(sourcePath));
  assert.deepEqual(
    documentSymbols
      .filter((symbol) => ["$token", "paint", ".card"].includes(symbol.name))
      .map((symbol) => symbol.name),
    ["$token", "paint", ".card"],
  );
  assert.deepEqual(
    (await index.workspaceSymbols("paint")).map((symbol) => symbol.name),
    ["paint"],
  );

  const createdPath = await write(root, "created.styl", "$created = true\n");
  await index.indexFile(createdPath);
  assert.deepEqual(
    (await index.workspaceSymbols("created")).map((symbol) => symbol.name),
    ["$created"],
  );
  await fs.unlink(createdPath);
  await index.removeFileUri(filePathToUri(createdPath));
  assert.deepEqual(await index.workspaceSymbols("created"), []);
});
