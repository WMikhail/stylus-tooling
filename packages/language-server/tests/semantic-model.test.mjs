import assert from "node:assert/strict";
import test from "node:test";

import { extractEmbeddedDocuments } from "../src/embedded-documents.mjs";
import { parseStylus, parserMetadata } from "../src/parser.mjs";
import { filePathToUri } from "../src/protocol.mjs";
import { buildSemanticModel } from "../src/semantic-model.mjs";

async function modelFor(source) {
  const uri = filePathToUri("/tmp/semantic.styl");
  const [embedded] = (await extractEmbeddedDocuments(uri, source)).documents;
  const parsed = await parseStylus(source);
  return buildSemanticModel(embedded, parsed);
}

test("uses the Stylus Tree-sitter WASM grammar and semantic query", async () => {
  const metadata = await parserMetadata();
  assert.equal(metadata.name, "stylus");
  assert.ok(metadata.abiVersion >= 14);
  assert.ok(metadata.nodeTypeCount > 100);
});

test("models lexical scopes, parameters, loops, and shadowing", async () => {
  const source = `$theme = global
paint($tone)
  color $theme
  $theme = local
  background $theme
  border-color $tone
items = 1
each item, index in items
  order index
  width item
`;
  const model = await modelFor(source);
  const symbols = new Map(
    model.symbols.map((symbol) => [
      `${symbol.kind}:${symbol.name}:${symbol.localNameStart}`,
      symbol,
    ]),
  );
  assert.ok([...symbols.keys()].some((key) => key.startsWith("mixin:paint:")));
  assert.ok([...symbols.keys()].some((key) => key.startsWith("parameter:$tone:")));
  assert.equal(model.symbols.filter((symbol) => symbol.name === "$theme").length, 2);
  assert.equal(model.symbols.filter((symbol) => symbol.kind === "loop-variable").length, 2);

  const themeReferences = model.references.filter(
    (reference) => reference.name === "$theme",
  );
  assert.equal(themeReferences.length, 2);
  const beforeShadow = model.resolveLocal(
    "$theme",
    ["variable"],
    themeReferences[0].localNameStart,
    themeReferences[0].scopeId,
  );
  const afterShadow = model.resolveLocal(
    "$theme",
    ["variable"],
    themeReferences[1].localNameStart,
    themeReferences[1].scopeId,
  );
  assert.equal(beforeShadow[0].value, "global");
  assert.equal(afterShadow[0].value, "local");

  for (const name of ["$tone", "item", "index"]) {
    const reference = model.references.find((candidate) => candidate.name === name);
    const resolved = model.resolveLocal(
      name,
      ["variable"],
      reference.localNameStart,
      reference.scopeId,
    );
    assert.equal(resolved.length, 1, `${name} should resolve in its lexical scope`);
  }
});

test("indexes callables, selectors, placeholders, keyframes, and their usages", async () => {
  const source = `sum($a, $b)
  return $a + $b
paint($tone)
  color $tone
$value = sum(1, 2)
.card, $base
  paint(red)
  @extend $base
  animation spin 1s
@keyframes spin
  from
    opacity 0
`;
  const model = await modelFor(source);
  const kinds = new Map(model.symbols.map((symbol) => [symbol.name, symbol.kind]));
  assert.equal(kinds.get("sum"), "function");
  assert.equal(kinds.get("paint"), "mixin");
  assert.equal(kinds.get(".card"), "selector");
  assert.equal(kinds.get("$base"), "placeholder");
  assert.equal(kinds.get("spin"), "keyframes");

  assert.ok(
    model.references.some(
      (reference) => reference.role === "call" && reference.name === "sum",
    ),
  );
  assert.ok(
    model.references.some(
      (reference) => reference.role === "call" && reference.name === "paint",
    ),
  );
  assert.ok(
    model.references.some(
      (reference) => reference.role === "extend" && reference.name === "$base",
    ),
  );
  assert.ok(
    model.references.some(
      (reference) => reference.role === "keyframes" && reference.name === "spin",
    ),
  );
});

test("incrementally reparses edits and tolerates partial invalid input", async () => {
  const first = await parseStylus("$x = red\n.a\n  color $x\n");
  const second = await parseStylus("$x = blue\n.a\n  color $x\n", first);
  assert.equal(second.incremental, true);

  const uri = filePathToUri("/tmp/partial.styl");
  const [embedded] = (await extractEmbeddedDocuments(uri, "$x = (\n.a\n  color $x\n"))
    .documents;
  const partial = await parseStylus(embedded.text);
  const model = await buildSemanticModel(embedded, partial);
  assert.ok(model.syntaxErrors.length > 0);
  assert.ok(model.symbols.some((symbol) => symbol.name === "$x"));

  first.dispose();
  second.dispose();
  model.dispose();
});
