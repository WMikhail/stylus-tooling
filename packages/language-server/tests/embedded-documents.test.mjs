import assert from "node:assert/strict";
import test from "node:test";

import { extractEmbeddedDocuments } from "../src/embedded-documents.mjs";
import { parseStylus } from "../src/parser.mjs";
import { filePathToUri } from "../src/protocol.mjs";
import { buildSemanticModel } from "../src/semantic-model.mjs";

test("extracts every literal Stylus Vue style block with compiler ranges", async () => {
  const uri = filePathToUri("/tmp/Компонент.vue");
  const source = `<template>😀</template>
<style scoped lang="stylus" module="theme">
$first = red
</style>
<style lang='css'>.ignored { color: red }</style>
<style data-owner="app" lang="styl">
$second = blue
</style>`;
  const extracted = await extractEmbeddedDocuments(uri, source);

  assert.equal(extracted.errors.length, 0);
  assert.equal(extracted.documents.length, 2);
  assert.equal(extracted.documents[0].text, "\n$first = red\n");
  assert.deepEqual(extracted.documents[0].attributes, {
    scoped: true,
    lang: "stylus",
    module: "theme",
  });
  assert.equal(extracted.documents[1].attributes["data-owner"], "app");
  assert.equal(
    source.slice(extracted.documents[1].hostStart, extracted.documents[1].hostEnd),
    extracted.documents[1].text,
  );
});

test("maps embedded ranges back to Vue UTF-16 positions", async () => {
  const uri = filePathToUri("/tmp/Emoji.vue");
  const source = `<template>😀</template>\n<style lang="stylus">😀 $token\n</style>`;
  const [embedded] = (await extractEmbeddedDocuments(uri, source)).documents;
  const tokenOffset = embedded.text.indexOf("$token");
  const range = embedded.toHostRange(tokenOffset, tokenOffset + 6);
  const hostOffset = source.indexOf("$token");

  assert.equal(embedded.hostLines.offsetAt(range.start), hostOffset);
  assert.equal(embedded.hostLines.offsetAt(range.end), hostOffset + 6);
  assert.equal(
    range.start.character - embedded.hostLines.positionAt(embedded.hostStart).character,
    3,
  );
});

test("supports Stylus style blocks in Svelte and Astro through the embedded abstraction", async () => {
  for (const extension of ["svelte", "astro"]) {
    const uri = filePathToUri(`/tmp/Component.${extension}`);
    const expression =
      extension === "svelte"
        ? `<div>{\`<style lang="stylus">$fake = blue</style>\`}</div>\n`
        : "";
    const source = `<script>const fake = '<style lang="stylus">';</script>\n${expression}<style lang="stylus" scoped>\n$x = red\n</style>`;
    const extracted = await extractEmbeddedDocuments(uri, source);
    assert.equal(extracted.documents.length, 1);
    assert.match(extracted.documents[0].kind, /-style$/);
    assert.match(extracted.documents[0].text, /\$x = red/);
    assert.doesNotMatch(extracted.documents[0].text, /\$fake/);
  }
});

test("dedents component style contents without losing host offset mappings", async () => {
  for (const extension of ["vue", "svelte", "astro"]) {
    const uri = filePathToUri(`/tmp/Indented.${extension}`);
    const source = `<style lang="stylus" scoped>
  @import "~variables"
  .card
    color red
</style>`;
    const [embedded] = (await extractEmbeddedDocuments(uri, source)).documents;

    assert.equal(embedded.text, `\n@import "~variables"\n.card\n  color red\n`);
    for (const token of ["@import", ".card", "color"]) {
      const localOffset = embedded.text.indexOf(token);
      const hostOffset = source.indexOf(token);
      assert.equal(embedded.toHostOffset(localOffset), hostOffset);
      assert.equal(embedded.toLocalOffset(hostOffset), localOffset);
    }

    const parsed = await parseStylus(embedded.text);
    const model = await buildSemanticModel(embedded, parsed);
    assert.deepEqual(model.syntaxErrors, []);
    model.dispose();
  }
});
