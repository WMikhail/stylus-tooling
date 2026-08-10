import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../src/diagnostics.mjs";
import { WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri, LineMap } from "../src/protocol.mjs";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

function positionOf(text, needle, occurrence = 0, inset = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = text.indexOf(needle, offset + 1);
  }
  assert.notEqual(offset, -1);
  return new LineMap(text).positionAt(offset + inset);
}

function firstLocation(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function definitionInFixture(project, relativeFile, symbol) {
  const root = path.join(FIXTURES, project);
  const filePath = path.join(root, relativeFile);
  const text = await fs.readFile(filePath, "utf8");
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  return index.definition(
    filePathToUri(filePath),
    positionOf(text, symbol, text.indexOf(symbol) === text.lastIndexOf(symbol) ? 0 : 1, 1),
  );
}

test("fixture catalog contains every roadmap ecosystem layout", async () => {
  const expected = [
    "aliases-include",
    "astro",
    "cyclic-imports",
    "monorepo",
    "multi-root",
    "nuxt",
    "pure-stylus",
    "quasar-1",
    "quasar-2",
    "svelte",
    "themes",
    "vite",
    "vue",
    "webpack",
  ];
  const actual = (await fs.readdir(FIXTURES, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, expected);
});

test("fixture projects resolve pure, component, framework, and config aliases", async () => {
  for (const [project, file, symbol, definitionSuffix] of [
    ["pure-stylus", "main.styl", "$fixture-token", "tokens.styl"],
    ["vue", "Component.vue", "$vue-token", "tokens.styl"],
    ["vite", "src/main.styl", "$vite-token", "src/tokens.styl"],
    ["webpack", "main.styl", "$webpack-token", "styles/tokens.styl"],
    ["nuxt", "app/main.styl", "$nuxt-token", "app/tokens.styl"],
    ["quasar-1", "src/pages/Index.vue", "$quasar-one", "variables.mat.styl"],
    ["quasar-2", "src/pages/Index.vue", "$quasar-two", "quasar.variables.styl"],
    ["svelte", "Component.svelte", "$svelte-token", "Component.svelte"],
    ["astro", "Component.astro", "$astro-token", "Component.astro"],
  ]) {
    const definition = await definitionInFixture(project, file, symbol);
    assert.ok(
      firstLocation(definition).uri.endsWith(definitionSuffix),
      `${project} definition`,
    );
  }
});

test("monorepo, multi-root, aliases/include paths, cycles, and themes fixtures work", async () => {
  const monorepo = path.join(FIXTURES, "monorepo");
  const monorepoIndex = new WorkspaceIndex([filePathToUri(monorepo)]);
  await monorepoIndex.rebuild();
  for (const packageName of ["a", "b"]) {
    const filePath = path.join(monorepo, "packages", packageName, "main.styl");
    const text = await fs.readFile(filePath, "utf8");
    const definition = await monorepoIndex.definition(
      filePathToUri(filePath),
      positionOf(text, `$package-${packageName}`, 0, 2),
    );
    assert.ok(firstLocation(definition).uri.includes(`/packages/${packageName}/styles/`));
  }

  const multiRoot = path.join(FIXTURES, "multi-root");
  const multiRootIndex = new WorkspaceIndex(
    ["root-a", "root-b"].map((name) => filePathToUri(path.join(multiRoot, name))),
  );
  await multiRootIndex.rebuild();
  assert.deepEqual(
    (await multiRootIndex.workspaceSymbols("$root-")).map((symbol) => symbol.name),
    ["$root-a", "$root-b"],
  );

  const aliases = path.join(FIXTURES, "aliases-include");
  const aliasIndex = new WorkspaceIndex([filePathToUri(aliases)]);
  aliasIndex.configure({
    stylus: { aliases: { tokens: "src/tokens" }, includePaths: ["shared"] },
  });
  await aliasIndex.rebuild();
  assert.equal(
    (await aliasIndex.diagnostics(filePathToUri(path.join(aliases, "main.styl")))).length,
    0,
  );

  const cycles = path.join(FIXTURES, "cyclic-imports");
  const cycleIndex = new WorkspaceIndex([filePathToUri(cycles)]);
  await cycleIndex.rebuild();
  assert.ok(
    (await cycleIndex.diagnostics(filePathToUri(path.join(cycles, "a.styl")))).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.cyclicImport,
    ),
  );

  const themes = path.join(FIXTURES, "themes");
  const themeIndex = new WorkspaceIndex([filePathToUri(themes)]);
  themeIndex.configure({
    stylus: {
      themes: { dark: "themes/dark.styl", light: "themes/light.styl" },
      activeTheme: "dark",
    },
  });
  await themeIndex.rebuild();
  const themeSource = await fs.readFile(path.join(themes, "main.styl"), "utf8");
  const themeDefinition = await themeIndex.definition(
    filePathToUri(path.join(themes, "main.styl")),
    positionOf(themeSource, "$theme-surface", 0, 2),
  );
  assert.ok(firstLocation(themeDefinition).uri.endsWith("themes/dark.styl"));
});

test("fixture copy exercises unsaved changes and file create/delete/rename/import updates", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-fixture-lifecycle-"));
  await fs.cp(path.join(FIXTURES, "pure-stylus"), temporary, { recursive: true });
  const index = new WorkspaceIndex([filePathToUri(temporary)]);
  await index.rebuild();
  const tokensPath = path.join(temporary, "tokens.styl");
  const tokensUri = filePathToUri(tokensPath);
  await index.openDocument(tokensUri, "$fixture-token = #ffffff\n$unsaved = red\n");
  assert.deepEqual(
    (await index.workspaceSymbols("unsaved")).map((symbol) => symbol.name),
    ["$unsaved"],
  );

  const createdPath = path.join(temporary, "created.styl");
  await fs.writeFile(createdPath, "$created = red\n");
  await index.indexFile(createdPath);
  assert.equal((await index.workspaceSymbols("created")).length, 1);

  const renamedPath = path.join(temporary, "renamed.styl");
  await fs.rename(createdPath, renamedPath);
  await index.removeFileUri(filePathToUri(createdPath));
  await index.indexFile(renamedPath);
  assert.equal(
    (await index.workspaceSymbols("created"))[0].location.uri,
    filePathToUri(renamedPath),
  );

  await fs.unlink(renamedPath);
  await index.removeFileUri(filePathToUri(renamedPath));
  assert.deepEqual(await index.workspaceSymbols("created"), []);

  await index.changeDocument(tokensUri, "$fixture-token = #000000\n");
  const mainPath = path.join(temporary, "main.styl");
  const definition = await index.definition(filePathToUri(mainPath), {
    line: 2,
    character: 10,
  });
  assert.equal(firstLocation(definition).uri, tokensUri);
});
