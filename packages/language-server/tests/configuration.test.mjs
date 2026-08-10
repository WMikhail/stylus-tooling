import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIAGNOSTIC_CODES } from "../src/diagnostics.mjs";
import { ImportResolver } from "../src/import-resolver.mjs";
import { discoverWorkspaceConfigurations } from "../src/static-configuration.mjs";
import { WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri, LineMap } from "../src/protocol.mjs";
import { createWorkspaceSettings } from "../src/workspace-settings.mjs";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-configuration-"));
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
  return new LineMap(text).positionAt(offset + inset);
}

function firstLocation(value) {
  return Array.isArray(value) ? value[0] : value;
}

test("statically reads Vite, Webpack, Nuxt, and tsconfig aliases without execution", async () => {
  const root = await workspace();
  await write(root, "package.json", JSON.stringify({ private: true }));
  await write(
    root,
    "vite.config.ts",
    `import path from "node:path";
export default defineConfig({ resolve: { alias: {
  "@vite": path.resolve(__dirname, "src/vite"),
  "@join": path.join("src", "joined"),
  "@relative-resolve": path.resolve("src", "resolved")
} } });`,
  );
  await write(
    root,
    "vite.config.mts",
    `import path from "node:path";
export default defineConfig({ resolve: { alias: { "@mts": path.resolve(__dirname, "src/mts") } } });`,
  );
  await write(
    root,
    "webpack.config.js",
    `const path = require("node:path");
module.exports = { resolve: { alias: { webpackTheme: path.resolve(__dirname, "src/webpack") } } };`,
  );
  await write(
    root,
    "nuxt.config.ts",
    `export default defineNuxtConfig({ srcDir: "app", alias: { nuxtTheme: "./src/nuxt" } });`,
  );
  await write(
    root,
    "tsconfig.json",
    `{"compilerOptions":{"baseUrl":".","paths":{"tokens/*":["src/tokens/*"]}}}`,
  );
  const discovered = await discoverWorkspaceConfigurations(root);
  assert.equal(discovered.messages.length, 0);
  const aliases = discovered.configurations[0].aliases;
  assert.equal(aliases["@vite"], path.join(root, "src/vite"));
  assert.equal(aliases["@join"], path.join(root, "src/joined"));
  assert.equal(aliases["@relative-resolve"], path.join(root, "src/resolved"));
  assert.equal(aliases["@mts"], path.join(root, "src/mts"));
  assert.equal(aliases.webpackTheme, path.join(root, "src/webpack"));
  assert.equal(aliases.nuxtTheme, path.join(root, "src/nuxt"));
  assert.equal(aliases.tokens, path.join(root, "src/tokens"));
  assert.equal(aliases["@"], path.join(root, "app"));
});

test("rejects dynamic configuration and never executes project code", async () => {
  const root = await workspace();
  const marker = path.join(root, "must-not-exist");
  await write(root, "package.json", JSON.stringify({ private: true }));
  await write(
    root,
    "vite.config.js",
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, "executed");
export default createRuntimeConfig();`,
  );
  const discovered = await discoverWorkspaceConfigurations(root);
  assert.ok(discovered.messages.some((message) => /dynamic/.test(message)));
  await assert.rejects(fs.access(marker));
});

test("bounds configuration discovery and honors gitignore and excludes", async () => {
  const root = await workspace();
  await write(root, "package.json", JSON.stringify({ private: true }));
  await write(root, ".gitignore", "ignored/\n");
  await write(root, "included/package.json", JSON.stringify({ private: true }));
  await write(root, "ignored/package.json", JSON.stringify({ private: true }));
  await write(root, "excluded/package.json", JSON.stringify({ private: true }));

  const discovered = await discoverWorkspaceConfigurations(
    root,
    createWorkspaceSettings({ exclude: ["excluded/**"] }),
  );
  assert.deepEqual(
    discovered.configurations.map((configuration) => configuration.rootPath),
    [root, path.join(root, "included")],
  );

  const bounded = await discoverWorkspaceConfigurations(
    root,
    createWorkspaceSettings({ maxWorkspaceEntries: 2 }),
  );
  assert.ok(
    bounded.messages.some((message) => /stopped after 2 filesystem entries/.test(message)),
  );
});

test("cancels configuration discovery before reading project files", async () => {
  const root = await workspace();
  const reason = new Error("cancelled configuration discovery");
  await assert.rejects(
    discoverWorkspaceConfigurations(root, createWorkspaceSettings(), {
      aborted: true,
      reason,
    }),
    reason,
  );
});

test("uses nearest package aliases in multi-root monorepositories", async () => {
  const parent = await workspace();
  const roots = [];
  const usages = [];
  const tokens = [];
  for (const name of ["one", "two"]) {
    const root = path.join(parent, name);
    roots.push(root);
    await write(root, "package.json", JSON.stringify({ private: true }));
    await write(
      root,
      "vite.config.js",
      `export default { resolve: { alias: { "@": "./src" } } };`,
    );
    tokens.push(await write(root, "src/tokens.styl", `$token-${name} = red\n`));
    const source = `@import "@/tokens"\n.a\n  color $token-${name}\n`;
    usages.push({ path: await write(root, "src/main.styl", source), source });
  }
  const index = new WorkspaceIndex(roots.map(filePathToUri));
  await index.rebuild();
  for (let item = 0; item < usages.length; item += 1) {
    const definition = await index.definition(
      filePathToUri(usages[item].path),
      positionOf(usages[item].source, `$token-${item === 0 ? "one" : "two"}`, 0, 3),
    );
    assert.equal(firstLocation(definition).uri, filePathToUri(tokens[item]));
  }
});

test("removes closed documents from deleted workspace roots but keeps reachable imports", async () => {
  const parent = await workspace();
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  const sharedPath = await write(parent, "shared.styl", "$shared = red\n");
  const firstSource = `@import "../shared"\n$first = $shared\n`;
  const firstPath = await write(firstRoot, "main.styl", firstSource);
  const secondPath = await write(secondRoot, "main.styl", "$second = blue\n");
  const index = new WorkspaceIndex(
    [firstRoot, secondRoot].map((root) => filePathToUri(root)),
  );
  await index.rebuild();

  index.setRoots([filePathToUri(firstRoot)]);
  await index.rebuild();

  assert.deepEqual(await index.workspaceSymbols("second"), []);
  assert.ok(!index.documentUris().includes(filePathToUri(secondPath)));
  assert.ok(index.documentUris().includes(filePathToUri(sharedPath)));
  const definition = await index.definition(
    filePathToUri(firstPath),
    positionOf(firstSource, "$shared", 0, 2),
  );
  assert.equal(firstLocation(definition).uri, filePathToUri(sharedPath));
});

test("applies changed workspace-specific aliases without restarting the index", async () => {
  const root = await workspace();
  const packageRoot = path.join(root, "packages", "app");
  const tokens = await write(packageRoot, "theme/tokens.styl", "$live-token = red\n");
  const source = `@import "theme"\n.a\n  color $live-token\n`;
  const usage = await write(packageRoot, "src/main.styl", source);
  const usageUri = filePathToUri(usage);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  assert.ok(
    (await index.diagnostics(usageUri)).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unresolvedImport,
    ),
  );

  index.configure({
    stylus: {
      workspaces: {
        "packages/app": { aliases: { theme: "theme/tokens.styl" } },
      },
    },
  });
  await index.refreshImports();
  assert.ok(
    !(await index.diagnostics(usageUri)).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unresolvedImport,
    ),
  );

  const definition = await index.definition(
    usageUri,
    positionOf(source, "$live-token", 0, 3),
  );
  assert.equal(firstLocation(definition).uri, filePathToUri(tokens));
});

test("gives normalized package settings precedence over global settings", () => {
  const root = path.join(path.sep, "workspace");
  const packageRoot = path.join(root, "packages", "app");
  const resolver = new ImportResolver({ rootPaths: [root] });
  resolver.configure({
    aliases: { tokens: "global/tokens" },
    activeTheme: "global",
    completionLimit: 200,
  });
  resolver.configureWorkspace(packageRoot, {
    aliases: { tokens: "package/tokens" },
    activeTheme: "package",
    completionLimit: 20,
    maxWorkspaceFiles: Number.MAX_SAFE_INTEGER,
  });

  const settings = resolver.settingsFor(path.join(packageRoot, "src", "main.styl"));
  assert.equal(settings.aliases.tokens, "package/tokens");
  assert.equal(settings.activeTheme, "package");
  assert.equal(settings.completionLimit, 20);
  assert.equal(settings.maxWorkspaceFiles, 500_000);
});

test("honors gitignore/excludes while retaining open unsaved documents", async () => {
  const root = await workspace();
  await write(root, ".gitignore", "ignored/\n");
  await write(root, "excluded/nope.styl", "$excluded = red\n");
  const ignoredPath = await write(root, "ignored/hidden.styl", "$hidden = red\n");
  await write(root, "visible.styl", "$visible = red\n");
  const index = new WorkspaceIndex([filePathToUri(root)]);
  index.configure({ stylus: { exclude: ["excluded/**"] } });
  await index.rebuild();
  assert.deepEqual(
    (await index.workspaceSymbols("visible")).map((symbol) => symbol.name),
    ["$visible"],
  );
  assert.deepEqual(await index.workspaceSymbols("hidden"), []);
  assert.deepEqual(await index.workspaceSymbols("excluded"), []);

  const ignoredUri = filePathToUri(ignoredPath);
  await index.openDocument(ignoredUri, `$live = blue\n.a\n  color $live\n`);
  const definition = await index.definition(ignoredUri, { line: 2, character: 10 });
  assert.equal(firstLocation(definition).uri, ignoredUri);
});

test("selects the active theme for definition and completion", async () => {
  const root = await workspace();
  const light = await write(root, "themes/light.styl", `$surface = white\n`);
  const dark = await write(root, "themes/dark.styl", `$surface = black\n`);
  const source = `.card\n  color $surface\n`;
  const sourcePath = await write(root, "main.styl", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  index.configure({
    stylus: {
      themes: { light: "themes/light.styl", dark: "themes/dark.styl" },
      activeTheme: "dark",
    },
  });
  await index.rebuild();
  const definition = await index.definition(
    filePathToUri(sourcePath),
    positionOf(source, "$surface", 0, 3),
  );
  assert.equal(firstLocation(definition).uri, filePathToUri(dark));
  assert.notEqual(firstLocation(definition).uri, filePathToUri(light));

  const completion = await index.completion(
    filePathToUri(sourcePath),
    positionOf(source, "$surface", 0, "$surface".length),
  );
  assert.ok(completion.items.some((item) => item.label === "$surface"));

  index.configure({ stylus: {} });
  await index.refreshImports();
  assert.ok(
    (await index.diagnostics(filePathToUri(sourcePath))).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
    ),
    "removing activeTheme should restore the default configuration",
  );
});

test("restores diagnostic defaults when settings are removed", async () => {
  const root = await workspace();
  const sourcePath = await write(root, "main.styl", `.a\n  color $missing\n`);
  const uri = filePathToUri(sourcePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  index.configure({ stylus: { diagnostics: false } });
  await index.rebuild();
  assert.deepEqual(await index.diagnostics(uri), []);

  index.configure({ stylus: {} });
  await index.refreshImports();
  assert.ok(
    (await index.diagnostics(uri)).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
    ),
  );
});

test("auto-detects Quasar 1 and Quasar 2 packages through the isolated preset", async () => {
  for (const version of ["^1.22.0", "^2.18.0"]) {
    const root = await workspace();
    await write(
      root,
      "package.json",
      JSON.stringify({ dependencies: { quasar: version } }),
    );
    const variables = await write(root, ".quasar/variables.styl", `$quasar-token = red\n`);
    const source = `@import "~variables"\n.a\n  color $quasar-token\n`;
    const sourcePath = await write(root, "src/main.styl", source);
    const index = new WorkspaceIndex([filePathToUri(root)]);
    await index.rebuild();
    const definition = await index.definition(
      filePathToUri(sourcePath),
      positionOf(source, "$quasar-token", 0, 3),
    );
    assert.equal(firstLocation(definition).uri, filePathToUri(variables));
  }
});
