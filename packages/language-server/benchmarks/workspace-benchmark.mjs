#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { WorkspaceIndex } from "../src/workspace-index.mjs";
import { filePathToUri } from "../src/protocol.mjs";

function requestedSizes() {
  const option = process.argv.find((argument) => argument.startsWith("--sizes="));
  return (option?.slice("--sizes=".length) ?? "1000,5000,10000")
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
}

const assertBudgets = process.argv.includes("--assert");

function performanceBudgets(fileCount) {
  return {
    coldIndexMs: 2_000 + fileCount,
    warmIndexMs: 1_000 + fileCount * 0.5,
    definitionMs: 250,
    referencesMs: 100 + fileCount * 0.1,
    completionMs: 500,
    singleDocumentUpdateMs: 500,
    dependentUpdateMs: 1_000,
    heapUsedMiB: 128 + fileCount * 0.05,
  };
}

async function measure(callback) {
  const started = performance.now();
  const value = await callback();
  return { durationMs: performance.now() - started, value };
}

async function generateWorkspace(fileCount) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `stylus-benchmark-${fileCount}-`));
  await fs.writeFile(path.join(root, "tokens.styl"), "$benchmark-token = #123456\n");
  const batchSize = 250;
  for (let start = 0; start < fileCount; start += batchSize) {
    const batch = [];
    for (let index = start; index < Math.min(fileCount, start + batchSize); index += 1) {
      const directory = path.join(root, `group-${Math.floor(index / 100)}`);
      const filePath = path.join(directory, `component-${index}.styl`);
      batch.push(
        fs
          .mkdir(directory, { recursive: true })
          .then(() =>
            fs.writeFile(
              filePath,
              `@import "../tokens"\n.component-${index}\n  color $benchmark-token\n`,
            ),
          ),
      );
    }
    await Promise.all(batch);
  }
  return root;
}

async function runScenario(fileCount) {
  const root = await generateWorkspace(fileCount);
  try {
    const rootUri = filePathToUri(root);
    const index = new WorkspaceIndex([rootUri]);
    const cold = await measure(() => index.rebuild());
    const warm = await measure(() => index.rebuild());
    const usagePath = path.join(root, "group-0", "component-0.styl");
    const usageUri = filePathToUri(usagePath);
    const definition = await measure(() =>
      index.definition(usageUri, { line: 2, character: 10 }),
    );
    const references = await measure(() =>
      index.references(filePathToUri(path.join(root, "tokens.styl")), {
        line: 0,
        character: 3,
      }),
    );
    const completion = await measure(() =>
      index.completion(usageUri, { line: 2, character: 24 }),
    );
    const usageText = await fs.readFile(usagePath, "utf8");
    const singleDocumentUpdate = await measure(() =>
      index.openDocument(usageUri, usageText.replace("color", "background")),
    );
    const tokenUri = filePathToUri(path.join(root, "tokens.styl"));
    const dependentUpdate = await measure(async () => {
      await index.openDocument(tokenUri, "$benchmark-token = #654321\n");
      return index.definition(usageUri, { line: 2, character: 15 });
    });
    return {
      files: fileCount,
      coldIndexMs: cold.durationMs,
      warmIndexMs: warm.durationMs,
      definitionMs: definition.durationMs,
      referencesMs: references.durationMs,
      completionMs: completion.durationMs,
      singleDocumentUpdateMs: singleDocumentUpdate.durationMs,
      dependentUpdateMs: dependentUpdate.durationMs,
      heapUsedMiB: process.memoryUsage().heapUsed / 1024 / 1024,
      index: index.snapshotMetrics(),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const size of requestedSizes()) {
  results.push(await runScenario(size));
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

if (assertBudgets) {
  const failures = [];
  for (const result of results) {
    for (const [metric, limit] of Object.entries(performanceBudgets(result.files))) {
      if (result[metric] > limit) {
        failures.push(
          `${result.files} files: ${metric} ${result[metric].toFixed(2)} exceeded ${limit.toFixed(2)}`,
        );
      }
    }
  }
  if (failures.length) {
    for (const failure of failures)
      console.error(`performance budget exceeded: ${failure}`);
    process.exitCode = 1;
  }
}
