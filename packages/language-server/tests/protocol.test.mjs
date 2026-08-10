import assert from "node:assert/strict";
import test from "node:test";

import {
  LineMap,
  filePathToUri,
  normalizeFilePath,
  uriToFilePath,
} from "../src/protocol.mjs";

test("maps offsets and LSP positions in UTF-16 code units", () => {
  const text = "ASCII\nкириллица\n😀 astral 𠮷 mixed\n";
  const lines = new LineMap(text);

  const emoji = text.indexOf("😀");
  assert.deepEqual(lines.positionAt(emoji), { line: 2, character: 0 });
  assert.deepEqual(lines.positionAt(emoji + 2), { line: 2, character: 2 });
  assert.equal(lines.offsetAt({ line: 2, character: 2 }), emoji + 2);

  const astral = text.indexOf("𠮷");
  const astralPosition = lines.positionAt(astral);
  assert.equal(lines.offsetAt(astralPosition), astral);
  assert.equal(lines.positionAt(astral + 2).character, astralPosition.character + 2);

  for (let offset = 0; offset <= text.length; offset += 1) {
    assert.equal(lines.offsetAt(lines.positionAt(offset)), offset);
  }
});

test("clamps invalid positions and excludes CRLF line terminators", () => {
  const lines = new LineMap("one\r\ntwo\r\n");
  assert.equal(lines.offsetAt({ line: 0, character: 99 }), 3);
  assert.equal(lines.offsetAt({ line: 1, character: 99 }), 8);
  assert.equal(lines.offsetAt({ line: 99, character: 0 }), 10);
});

test("normalizes Windows paths and file URIs independently of the host OS", () => {
  const normalized = normalizeFilePath("c:/Work/Theme/../tokens.styl");
  assert.equal(normalized, "C:\\Work\\tokens.styl");
  const uri = filePathToUri(normalized);
  assert.equal(uri, "file:///C:/Work/tokens.styl");
  assert.equal(uriToFilePath(uri), normalized);
  assert.equal(uriToFilePath("https://example.com/main.styl"), null);
});
