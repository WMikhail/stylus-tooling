import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";

import { DiagnosticsScheduler } from "../src/diagnostics-scheduler.mjs";
import { DIAGNOSTIC_CODES } from "../src/diagnostics.mjs";
import { WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri } from "../src/protocol.mjs";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stylus-diagnostics-"));
}

async function write(root, relative, text) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
  return filePath;
}

test("reports stable semantic diagnostic codes without flagging CSS literals", async () => {
  const root = await workspace();
  const source = `@import "./missing"
duplicate()
  return 1
duplicate()
  return 2
.card
  $unused = 1
  color $missing
  width noSuchFunction(1)
  noSuchMixin()
  animation absentFrames 1s
  background rebeccapurple
  border-color red
$broken = (
`;
  const sourcePath = await write(root, "main.styl", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const diagnostics = await index.diagnostics(filePathToUri(sourcePath));
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));

  for (const code of [
    DIAGNOSTIC_CODES.unresolvedImport,
    DIAGNOSTIC_CODES.unknownVariable,
    DIAGNOSTIC_CODES.unknownFunction,
    DIAGNOSTIC_CODES.unknownMixin,
    DIAGNOSTIC_CODES.unknownKeyframes,
    DIAGNOSTIC_CODES.conflictingDefinition,
    DIAGNOSTIC_CODES.unusedLocalVariable,
    DIAGNOSTIC_CODES.syntaxError,
  ]) {
    assert.ok(codes.has(code), `expected ${code}`);
  }
  assert.ok(
    !diagnostics.some((diagnostic) =>
      /rebeccapurple|variable 'red'/.test(diagnostic.message),
    ),
  );
  assert.deepEqual(
    diagnostics,
    [...diagnostics].sort(
      (left, right) =>
        left.range.start.line - right.range.start.line ||
        left.range.start.character - right.range.start.character ||
        String(left.code).localeCompare(String(right.code)),
    ),
  );
});

test("does not flag animation keywords, animation variables, or Stylus built-ins", async () => {
  const root = await workspace();
  const source = `$duration = 1s
@keyframes spin
  from
    opacity 0
.card
  animation spin $duration ease-in infinite forwards
  content typeof(12px)
  color adjust(#fff, "lightness", -10%)
  transform rotate(180deg) translateX(2px)
  width calc(100% - 2px)
  width missingFunction(1)
`;
  const sourcePath = await write(root, "main.styl", source);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  const diagnostics = await index.diagnostics(filePathToUri(sourcePath));

  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === DIAGNOSTIC_CODES.unknownFunction &&
        diagnostic.message.includes("missingFunction"),
    ),
  );
  assert.ok(
    !diagnostics.some((diagnostic) =>
      /\$duration|ease-in|infinite|forwards|typeof|adjust|rotate|translateX|calc/.test(
        diagnostic.message,
      ),
    ),
  );
});

test("recognizes whitespace and easing literals without hiding unknown variables", async () => {
  const root = await workspace();
  const source = `.modal > .modal-content > .modal-body.modal-message
  white-space pre-wrap

body.desktop table.q-table.highlight tbody tr
  transition all .28s ease-in
  white-space pre
  white-space pre-line
  white-space nowrap
  white-space break-spaces
  transition-timing-function ease
  transition-timing-function ease-out
  transition-timing-function ease-in-out
  transition-timing-function linear
  transition-timing-function step-start
  transition-timing-function step-end
  animation-timing-function ease-in
  white-space pre-warp
  transition all .28s eas-in
  white-space $pre-wrap
  transition all .28s $ease-in
`;
  const index = new WorkspaceIndex([filePathToUri(root)]);
  try {
    for (const extension of ["styl", "vue"]) {
      const uri = filePathToUri(path.join(root, `main.${extension}`));
      const text =
        extension === "vue"
          ? `<template><div/></template>\n<style lang="stylus">\n${source}</style>`
          : source;
      await index.openDocument(uri, text);
      assert.deepEqual(
        (await index.diagnostics(uri)).map(({ code, message }) => ({ code, message })),
        ["pre-warp", "eas-in", "$pre-wrap", "$ease-in"].map((name) => ({
          code: DIAGNOSTIC_CODES.unknownVariable,
          message: `Unknown variable '${name}'.`,
        })),
        extension,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publishes only the latest diagnostics computation for a URI", async () => {
  const uri = filePathToUri("/tmp/latest-diagnostics.styl");
  const pending = [];
  const published = [];
  let version = 1;
  let computationStarted;
  const waitForComputation = () =>
    new Promise((resolve) => {
      computationStarted = resolve;
    });
  const scheduler = new DiagnosticsScheduler({
    openUris: () => [uri],
    debounceMs: () => 0,
    compute: () =>
      new Promise((resolve) => {
        pending.push(resolve);
        computationStarted?.();
        computationStarted = null;
      }),
    publish: (params) => published.push(params),
    reportError: (error) => assert.fail(String(error)),
    versionForUri: () => version,
  });

  let started = waitForComputation();
  scheduler.schedule([uri]);
  await started;
  version = 2;
  started = waitForComputation();
  scheduler.schedule([uri]);
  await started;

  pending[1]([{ message: "current" }]);
  await Promise.resolve();
  pending[0]([{ message: "stale" }]);
  await Promise.resolve();

  assert.deepEqual(published, [{ uri, version: 2, diagnostics: [{ message: "current" }] }]);
});

test("aborts a diagnostics computation superseded by a newer request", async () => {
  const uri = filePathToUri("/tmp/cancelled-diagnostics.styl");
  let calls = 0;
  let firstSignal;
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const scheduler = new DiagnosticsScheduler({
    openUris: () => [uri],
    debounceMs: () => 0,
    compute: (_uri, signal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve([]);
      firstSignal = signal;
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    publish: () => {},
    reportError: (error) => assert.fail(String(error)),
    versionForUri: () => 1,
  });

  scheduler.schedule([uri]);
  await firstStarted;
  scheduler.schedule([uri]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstSignal.aborted, true);
  scheduler.cancel(uri);
});

test("reports import cycles on the exact participating imports", async () => {
  const root = await workspace();
  const aPath = await write(root, "a.styl", `@import "./b"\n$a = 1\n`);
  const bPath = await write(root, "b.styl", `@require "./a"\n$b = 2\n`);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();

  for (const filePath of [aPath, bPath]) {
    const diagnostics = await index.diagnostics(filePathToUri(filePath));
    const cycle = diagnostics.find(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.cyclicImport,
    );
    assert.ok(cycle);
    assert.equal(cycle.range.start.line, 0);
  }
});

test("supports per-rule disablement and severity configuration", async () => {
  const root = await workspace();
  const sourcePath = await write(root, "main.styl", `.a\n  color $missing\n$broken = (\n`);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  index.configure({
    stylus: {
      diagnostics: {
        rules: {
          unknownVariable: false,
          syntaxError: { severity: "hint" },
        },
      },
    },
  });
  await index.rebuild();
  const diagnostics = await index.diagnostics(filePathToUri(sourcePath));
  assert.ok(
    !diagnostics.some((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable),
  );
  assert.ok(
    diagnostics
      .filter((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.syntaxError)
      .every((diagnostic) => diagnostic.severity === 4),
  );
});

test("recomputes dependents from unsaved imported documents and clears fixed diagnostics", async () => {
  const root = await workspace();
  const tokenPath = await write(root, "tokens.styl", `$token = red\n`);
  const usagePath = await write(
    root,
    "usage.styl",
    `@import "./tokens"\n.a\n  color $token\n`,
  );
  const tokenUri = filePathToUri(tokenPath);
  const usageUri = filePathToUri(usagePath);
  const index = new WorkspaceIndex([filePathToUri(root)]);
  await index.rebuild();
  assert.ok(
    !(await index.diagnostics(usageUri)).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
    ),
  );

  await index.openDocument(tokenUri, `$renamed = red\n`);
  assert.ok(
    (await index.diagnostics(usageUri)).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
    ),
  );

  await index.changeDocument(tokenUri, `$token = blue\n`);
  assert.ok(
    !(await index.diagnostics(usageUri)).some(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.unknownVariable,
    ),
  );
});
