import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeDocument, filePathToUri, WorkspaceIndex } from "../src/analyzer.mjs";
import { DIAGNOSTIC_CODES } from "../src/diagnostics.mjs";
import { LineMap } from "../src/protocol.mjs";

const cases = {
  "semicolons and dedents":
    '@import "./tokens";\n.a\n  width: 100%;\n  content:counter(item);\n  font-size:24px;\n  position:absolute;\n  a:hover\n  // comment before the body\n    color:red;\n  @extend a:hover\n.b\n  height 20px;\n.c { color:red; width:100%; }\n',
  "space-separated lists":
    '$x = 2px\n$y = 3px\n.a\n  margin "-%s -%s" % ($x $y)\n  flex 0 0 "calc((100% - %s) / %s)" % (($x * ($y - 1)) ($y))\n',
  "calls through variables":
    "text_style()\n  color red\nflat_style($text_fn = text_style)\n  $text_fn()\n.a\n  flat_style()\n",
  "continued values":
    '.a\n  grid-template-areas "a a b"\\\n    "c d e"\\\n    "f f f"\n.b\n  color blue\n',
  "percentage casts and arithmetic":
    "$width = 100\n.a\n  width (2000 / $width) %\n  height (20 / 2)%\n  opacity (1 - .5)\n  order (9 % 2)\n",
  "mixed root indentation":
    '\n  @import "./tokens"\n  .a\n    color red\n.b\n  color blue\n',
  "comment-only indentation":
    "/*.row*/\n  /*background red*/\n.a\n    // indented comment\n  color red\n    /* multiline\n       comment */\n  width 1px\n",
  "trailing comment without a newline": ".a\n  color red\n      // end",
  "braces inside declaration strings": `.a\n  content:counter(item) "{";\n  font-family:Arial, '{';\n  content:counter(item) "http://a/{";\n  width:100%;\n.b\n  color blue\n`,
  "selector groups":
    ".a\n  color:red // {\n  a:hover,\n  a:focus\n    color blue\n  a:is(.x)\n  a:not(.y)\n    color green\n  a:custom,\n  a:other\n    color black\n  #abc,\n  #def\n    color #fff\n  #abcd\n  #defa\n    color #abcd\n.tabbed\n\t#abc,\n\t#def\n\t\tcolor #fff\n",
  "combined deep selectors":
    ".a > /deep/ .label\n  color red\n.b > >>> .label\n  color blue\n",
  "prefixed keyframes":
    "@-webkit-keyframes blink {\n  0% { color: #fff; }\n  100% { color: rgba(255, 255, 255, 0); }\n}\n@keyframes blink\n  from\n    opacity 0\n",
  "HEX-like IDs and colors":
    "paint(color = #fff)\n  background color\n#add_num\n  color #add\n#abcdefabc\n  color #abcdef\n#abc\n// comment before the body\n  background #abcd\n",
};

for (const [name, source] of Object.entries(cases)) {
  test(`parses ${name} in standalone and Vue styles`, async () => {
    for (const extension of ["styl", "vue"]) {
      const text =
        extension === "vue"
          ? `<template><div/></template>\n<style lang="stylus">${source}</style>`
          : source;
      const document = await analyzeDocument(
        filePathToUri(`/tmp/compatibility.${extension}`),
        text,
      );
      try {
        assert.equal(document.models.length, 1);
        assert.equal(document.models[0].parsed.tree.rootNode.hasError, false, name);
        assert.deepEqual(document.models[0].syntaxErrors, [], name);
        assert.deepEqual(document.errors, []);
        const tree = document.models[0].parsed.tree.rootNode;
        if (name === "semicolons and dedents") {
          assert.deepEqual(
            tree
              .descendantsOfType("css_declaration_block")[0]
              .namedChildren.map((node) => node.childForFieldName("property")?.text),
            ["color", "width"],
          );
        }
        if (name === "percentage casts and arithmetic") {
          const modulo = tree
            .descendantsOfType("binary_expression")
            .find((node) => node.childForFieldName("operator")?.text === "%");
          assert.equal(modulo?.text, "9 % 2");
          assert.deepEqual(
            tree.descendantsOfType("cast_expression").map((node) => node.text),
            ["(2000 / $width) %", "(20 / 2)%"],
          );
        }
        if (name === "selector groups") {
          assert.deepEqual(
            tree
              .descendantsOfType("nested_selector_list")
              .map((node) => node.namedChildCount),
            [2, 2, 2, 2, 2, 2],
          );
          assert.deepEqual(
            tree.descendantsOfType("color_value").map((node) => node.text),
            ["#fff", "#abcd", "#fff"],
          );
        }
        if (name === "trailing comment without a newline") {
          assert.equal(tree.descendantsOfType("rule_set").length, 1);
          assert.equal(tree.descendantsOfType("declaration")[0]?.text, "color red");
        }
        if (name === "braces inside declaration strings") {
          assert.deepEqual(
            tree
              .descendantsOfType("declaration")
              .map((node) => node.childForFieldName("property")?.text),
            ["content", "font-family", "content", "width", "color"],
          );
        }
      } finally {
        for (const model of document.models) model.dispose();
      }
    }
  });
}

test("reports missing punctuation in incomplete CSS blocks", async () => {
  const document = await analyzeDocument(
    filePathToUri("/tmp/incomplete.styl"),
    ".a {\n  color: red;\n",
  );
  try {
    assert.ok(
      document.models[0].syntaxErrors.some((error) => error.message === "Missing }"),
    );
  } finally {
    document.models[0].dispose();
  }
});

test("property-named mixins support definitions, calls, and imports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-property-mixins-"));
  const libPath = path.join(root, "lib.styl");
  const libUri = filePathToUri(libPath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  const names = [
    "border",
    "font",
    "list",
    "text",
    "outline",
    "overflow",
    "animation",
    "transition",
    "flex",
    "grid",
    "place",
  ];
  try {
    for (const name of names) {
      for (const parameters of ["", "$a", "$a, $b = normal"]) {
        const value = parameters ? "$a" : '"Arial"';
        const source = `${name}(${parameters})\n  font-family ${value}\n\nafter-mix()\n  color red\n\nnested()\n  ${name}(${parameters})\n    font-family ${value}\n  ${name}("Arial")\n\n${name}("Arial")\n.a\n  ${name}("Arial")\n  after-mix()\n`;
        await fs.writeFile(libPath, source);
        await index.openDocument(libUri, source);
        assert.deepEqual(await index.diagnostics(libUri), [], `${name}(${parameters})`);
        for (const extension of ["styl", "vue"]) {
          const uri = filePathToUri(path.join(root, `use.${extension}`));
          const usage = `@import "./lib.styl"\n.a\n  ${name}("Arial")\n  after-mix()\n`;
          const text =
            extension === "vue"
              ? `<template><div/></template>\n<style lang="stylus">\n${usage}</style>`
              : usage;
          const lineOffset = extension === "vue" ? 2 : 0;
          await index.openDocument(uri, text);
          assert.deepEqual(await index.diagnostics(uri), [], `${name} in ${extension}`);
          for (const [line, definitionLine] of [
            [2, 0],
            [3, 3],
          ]) {
            const definition = await index.definition(uri, {
              line: line + lineOffset,
              character: 3,
            });
            assert.equal(definition?.uri, libUri, name);
            assert.equal(definition?.range.start.line, definitionLine, name);
          }
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("variable calls resolve to parameters and support references, rename, and diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-variable-calls-"));
  const source =
    "paint()\n  color red\napply($fn = paint)\n  $fn()\napply_plain(fn = paint)\n  fn()\n$alias = paint\n.a\n  $alias()\n  apply()\n  apply_plain()\n";
  const uri = filePathToUri(path.join(root, "main.styl"));
  const index = new WorkspaceIndex([filePathToUri(root)]);
  const lines = new LineMap(source);
  try {
    await fs.writeFile(path.join(root, "main.styl"), source);
    await index.rebuild();
    for (const [name, declarationLine] of [
      ["$fn", 2],
      ["fn", 4],
      ["$alias", 6],
    ]) {
      const offset = source.indexOf(`\n  ${name}()`) + 3;
      const position = lines.positionAt(offset + 1);
      const definition = await index.definition(uri, position);
      assert.equal(definition?.range.start.line, declarationLine, name);
      const references = await index.references(uri, position, true);
      assert.equal(references.length, 2, name);
      const newName = name.startsWith("$") ? "$callback" : "callback";
      const edit = await index.rename(uri, position, newName);
      assert.equal(edit.changes[uri].length, 2, name);
    }
    const paintPosition = lines.positionAt(source.indexOf("= paint") + 3);
    assert.equal((await index.definition(uri, paintPosition))?.range.start.line, 0);
    assert.equal((await index.references(uri, paintPosition, true)).length, 4);
    assert.equal((await index.rename(uri, paintPosition, "brush")).changes[uri].length, 4);
    assert.deepEqual(await index.diagnostics(uri), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("builtin function values are recognized while unknown names still produce diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-builtin-values-"));
  const index = new WorkspaceIndex([filePathToUri(root)]);
  const source =
    'unit_fn = unit\nformat(fn = unit)\n  fn(2, "px")\n.a\n  width unit_fn(1, "px")\n  height format()\nbad_fn = unti\n';
  try {
    for (const extension of ["styl", "vue"]) {
      const uri = filePathToUri(path.join(root, `main.${extension}`));
      const text =
        extension === "vue"
          ? `<template><div/></template>\n<style lang="stylus">${source}</style>`
          : source;
      await index.openDocument(uri, text);
      assert.deepEqual(
        (await index.diagnostics(uri)).map(({ code, message }) => ({ code, message })),
        [{ code: DIAGNOSTIC_CODES.unknownVariable, message: "Unknown variable 'unti'." }],
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CSS counter identifiers permit literals and preserve variable navigation and diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-counter-identifiers-"));
  const index = new WorkspaceIndex([filePathToUri(root)]);
  const source =
    'item_name = "item"\n.a\n  content:counter(item, custom-style)\n  content:counters(section, ".", custom-style)\n  content counter(item_name)\n  content counter($missing)\n  content counter(missing_value * 2)\n';
  try {
    for (const extension of ["styl", "vue"]) {
      const uri = filePathToUri(path.join(root, `main.${extension}`));
      const text =
        extension === "vue"
          ? `<template><div/></template>\n<style lang="stylus">${source}</style>`
          : source;
      await index.openDocument(uri, text);
      assert.deepEqual(
        (await index.diagnostics(uri)).map(({ code, message }) => ({ code, message })),
        ["$missing", "missing_value"].map((name) => ({
          code: DIAGNOSTIC_CODES.unknownVariable,
          message: `Unknown variable '${name}'.`,
        })),
      );
      const position = new LineMap(text).positionAt(text.indexOf("counter(item_name)") + 9);
      const definition = await index.definition(uri, position);
      assert.equal(definition?.range.start.line, extension === "vue" ? 1 : 0);
      assert.equal((await index.references(uri, position, true)).length, 2);
      assert.equal(
        (await index.rename(uri, position, "counter_name")).changes[uri].length,
        2,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("vendor keyframes coexist while duplicate definitions still produce diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-keyframes-"));
  const uri = filePathToUri(path.join(root, "main.styl"));
  const index = new WorkspaceIndex([filePathToUri(root)]);
  const source =
    ["webkit", "moz", "o", "ms"]
      .map((prefix) => `@-${prefix}-keyframes blink\n  from\n    opacity 0\n`)
      .join("") + "@keyframes blink\n  from\n    opacity 0\n";
  try {
    await fs.writeFile(path.join(root, "main.styl"), source);
    await index.rebuild();
    assert.deepEqual(await index.diagnostics(uri), []);
    await index.openDocument(uri, source + source);
    assert.equal(
      (await index.diagnostics(uri)).filter(
        (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.conflictingDefinition,
      ).length,
      5,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
