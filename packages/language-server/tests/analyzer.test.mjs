import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceIndex, analyzeDocument, filePathToUri } from "../src/analyzer.mjs";

async function temporaryWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-lsp-"));
}

async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

test("finds a definition in the same Stylus document", async () => {
  const root = await temporaryWorkspace();
  const sourcePath = await writeFile(
    root,
    "main.styl",
    "$primary = #3498db\n.button\n  color $primary\n",
  );
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const definition = await index.definition(uri, { line: 2, character: 10 });
  assert.equal(definition.uri, uri);
  assert.deepEqual(definition.range.start, { line: 0, character: 0 });
});

test("only analyzes Stylus style blocks in Vue documents", async () => {
  const uri = filePathToUri("/tmp/Component.vue");
  const source = `<template><div>{{ $ignored }}</div></template>\n<style lang="stylus">\n$inside = red\n.a\n  color $inside\n</style>\n<style>\n$css = nope;\n</style>\n`;
  const document = await analyzeDocument(uri, source);

  assert.deepEqual(
    document.definitions
      .filter((definition) => definition.kind === "variable")
      .map((definition) => definition.name),
    ["$inside"],
  );
  assert.equal(document.regions.length, 1);
});

test("resolves the legacy Quasar variables import chain from Vue", async () => {
  const root = await temporaryWorkspace();
  const componentPath = await writeFile(
    root,
    "src/components/pages/Index.vue",
    `<template><div/></template>\n<style lang="stylus" scoped>\n  @import "~variables"\n  .container\n    background $bg-neutral\n</style>\n`,
  );
  await writeFile(root, ".quasar/variables.styl", "@import '~quasar-app-variables'\n");
  await writeFile(
    root,
    "src/css/themes/variables.mat.styl",
    "@import 'common.variables'\n",
  );
  const definitionPath = await writeFile(
    root,
    "src/css/themes/common.variables.styl",
    "$bg-neutral = #F6F6F6\n",
  );

  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const definition = await index.definition(filePathToUri(componentPath), {
    line: 4,
    character: 17,
  });

  assert.equal(definition.uri, filePathToUri(definitionPath));
  assert.deepEqual(definition.range.start, { line: 0, character: 0 });
});

test("injects Quasar 0.17 variables into nested package components", async () => {
  const root = await temporaryWorkspace();
  const app = path.join(root, "apps", "legacy");
  await writeFile(
    app,
    "package.json",
    JSON.stringify({ dependencies: { "quasar-framework": "0.17.20" } }),
  );
  await writeFile(
    app,
    ".quasar/variables.styl",
    "@import '~quasar-app-variables'\n@import '~quasar-framework/src/css/core.variables'\n",
  );
  await writeFile(app, "src/css/themes/variables.mat.styl", "@import 'common.variables'\n");
  const spacingPath = await writeFile(
    app,
    "src/css/themes/common.variables.styl",
    "$spacing-lg = 20px\n",
  );
  await writeFile(
    app,
    "node_modules/quasar-framework/src/css/core.variables.styl",
    "$quasar-core = #027be3\n",
  );
  const source = `<style lang="stylus">
.card
  padding-right $spacing-lg
  color $quasar-core
</style>
`;
  const componentPath = await writeFile(app, "src/pages/Card.vue", source);
  const componentUri = filePathToUri(componentPath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const diagnostics = await index.diagnostics(componentUri);
  assert.ok(
    !diagnostics.some((diagnostic) => diagnostic.code === "stylus.unknown-variable"),
    diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
  );
  const definition = await index.definition(componentUri, {
    line: 2,
    character: 19,
  });
  assert.equal(definition.uri, filePathToUri(spacingPath));
});

test("falls back to a unique workspace definition", async () => {
  const root = await temporaryWorkspace();
  const definitionPath = await writeFile(root, "tokens.styl", "$token = red\n");
  const usagePath = await writeFile(root, "nested/usage.styl", ".a\n  color $token\n");
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const definition = await index.definition(filePathToUri(usagePath), {
    line: 1,
    character: 10,
  });
  assert.equal(definition.uri, filePathToUri(definitionPath));
});

test("resolves configured import aliases", async () => {
  const root = await temporaryWorkspace();
  const definitionPath = await writeFile(
    root,
    "src/styles/tokens/colors.styl",
    "$brand = rebeccapurple\n",
  );
  const usagePath = await writeFile(
    root,
    "src/components/button.styl",
    '@import "~tokens/colors"\n.button\n  color $brand\n',
  );
  const index = new WorkspaceIndex([filePathToUri(root)]);
  index.configure({
    stylus: { aliases: { tokens: "src/styles/tokens" } },
  });
  await index.rebuild();

  const definition = await index.definition(filePathToUri(usagePath), {
    line: 2,
    character: 10,
  });
  assert.equal(definition.uri, filePathToUri(definitionPath));
});

test("returns all workspace definitions when the fallback is ambiguous", async () => {
  const root = await temporaryWorkspace();
  await writeFile(root, "themes/light.styl", "$surface = white\n");
  await writeFile(root, "themes/dark.styl", "$surface = black\n");
  const usagePath = await writeFile(root, "usage.styl", ".panel\n  background $surface\n");
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  const definitions = await index.definition(filePathToUri(usagePath), {
    line: 1,
    character: 15,
  });
  assert.equal(definitions.length, 2);
  assert.deepEqual(
    new Set(definitions.map((definition) => definition.uri)),
    new Set([
      filePathToUri(path.join(root, "themes/light.styl")),
      filePathToUri(path.join(root, "themes/dark.styl")),
    ]),
  );
});

test("uses unsaved contents for open documents", async () => {
  const root = await temporaryWorkspace();
  const sourcePath = await writeFile(root, "main.styl", ".a\n  color $live\n");
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  index.openDocument(uri, "$live = blue\n.a\n  color $live\n");

  const definition = await index.definition(uri, { line: 2, character: 10 });
  assert.deepEqual(definition.range.start, { line: 0, character: 0 });
});
