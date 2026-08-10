import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ImportResolver } from "../src/import-resolver.mjs";
import { filePathToUri } from "../src/protocol.mjs";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-resolver-"));
}

async function write(root, relative, text = "") {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
  return filePath;
}

test("resolves relative files, both extensions, and index files", async () => {
  const root = await workspace();
  const importer = await write(root, "src/main.styl");
  const stylus = await write(root, "src/long.stylus");
  const dotted = await write(root, "src/common.variables.styl");
  const indexed = await write(root, "src/theme/index.styl");
  const resolver = new ImportResolver({ rootPaths: [root] });

  assert.equal((await resolver.resolve("./long", importer))[0].filePath, stylus);
  assert.equal(
    (await resolver.resolve("./common.variables", importer))[0].filePath,
    dotted,
  );
  assert.equal((await resolver.resolve("./theme", importer))[0].filePath, indexed);
});

test("resolves aliases, include paths, node_modules, tilde, and globs", async () => {
  const root = await workspace();
  const importer = await write(root, "src/components/main.styl");
  const alias = await write(root, "src/tokens/colors.styl");
  const include = await write(root, "shared/spacing.styl");
  const moduleFile = await write(root, "node_modules/design/index.styl");
  const firstGlob = await write(root, "src/partials/a.styl");
  const secondGlob = await write(root, "src/partials/b.stylus");
  const resolver = new ImportResolver({ rootPaths: [root] });
  resolver.configure({
    aliases: { tokens: "src/tokens" },
    includePaths: ["shared"],
  });

  assert.equal((await resolver.resolve("~tokens/colors", importer))[0].filePath, alias);
  assert.equal((await resolver.resolve("spacing", importer))[0].filePath, include);
  assert.equal((await resolver.resolve("~design", importer))[0].filePath, moduleFile);
  assert.deepEqual(
    (await resolver.resolve("../partials/*", importer)).map((entry) => entry.filePath),
    [firstGlob, secondGlob],
  );
});

test("resolves Stylus package main entries and directory basename fallbacks", async () => {
  const root = await workspace();
  const importer = await write(root, "src/main.styl");
  const packageMain = await write(root, "node_modules/theme/styles/entry.styl");
  await write(
    root,
    "node_modules/theme/package.json",
    JSON.stringify({ main: "styles/entry.styl" }),
  );
  const basename = await write(root, "src/components/button/button.styl");
  const resolver = new ImportResolver({ rootPaths: [root] });

  assert.equal((await resolver.resolve("~theme", importer))[0].filePath, packageMain);
  assert.equal(
    (await resolver.resolve("./components/button", importer))[0].filePath,
    basename,
  );
});

test("only applies the Quasar preset when enabled or safely detected", async () => {
  const root = await workspace();
  const importer = await write(root, "src/pages/main.styl");
  const variables = await write(root, ".quasar/variables.styl");
  const resolver = new ImportResolver({ rootPaths: [root] });
  resolver.configure({ presets: { quasar: false } });
  assert.deepEqual(await resolver.resolve("~variables", importer), []);

  resolver.configure({ presets: { quasar: true } });
  assert.equal((await resolver.resolve("~variables", importer))[0].filePath, variables);
  assert.equal((await resolver.resolveImplicit(importer))[0].filePath, variables);
});

test("detects legacy quasar-framework and exposes generated variables implicitly", async () => {
  const root = await workspace();
  const importer = await write(root, "src/pages/main.styl");
  const variables = await write(root, ".quasar/variables.styl");
  await write(
    root,
    "package.json",
    JSON.stringify({ dependencies: { "quasar-framework": "0.17.20" } }),
  );
  const resolver = new ImportResolver({ rootPaths: [root] });

  assert.equal((await resolver.resolveImplicit(importer))[0].filePath, variables);

  resolver.configure({ presets: { quasar: false } });
  assert.deepEqual(await resolver.resolveImplicit(importer), []);
});

test("requires explicit permission for absolute paths and file URIs", async () => {
  const root = await workspace();
  const importer = await write(root, "main.styl");
  const target = await write(root, "absolute.styl");
  const resolver = new ImportResolver({ rootPaths: [root] });
  assert.deepEqual(await resolver.resolve(target, importer), []);
  assert.deepEqual(await resolver.resolve(filePathToUri(target), importer), []);

  resolver.configure({ allowAbsolutePaths: true });
  assert.equal((await resolver.resolve(target, importer))[0].filePath, target);
  assert.equal(
    (await resolver.resolve(filePathToUri(target), importer))[0].filePath,
    target,
  );
});
