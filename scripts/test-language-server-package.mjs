#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(root, "packages", "language-server");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function quoteWindowsArgument(argument) {
  return `"${argument.replaceAll('"', '""')}"`;
}

function run(command, args, cwd) {
  const isWindows = process.platform === "win32";
  const executable = isWindows
    ? `${command} ${args.map(quoteWindowsArgument).join(" ")}`
    : command;
  const result = spawnSync(executable, isWindows ? [] : args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    env: {
      ...process.env,
      npm_config_cache: path.join(temporaryDirectory, "npm-cache"),
    },
  });
  if (result.status !== 0) {
    const failure =
      result.error?.stack ||
      result.stderr ||
      result.stdout ||
      `process exited with status ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed:\n${failure}`);
  }
  return result.stdout;
}

function send(child, message) {
  const json = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function responseReader(child) {
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (!Number.isFinite(length) || buffer.length < end) {
        return;
      }
      const message = JSON.parse(buffer.subarray(start, end).toString("utf8"));
      buffer = buffer.subarray(end);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  return (id, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for LSP response ${id}: ${stderr}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
}

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "stylus language server package-"),
);

try {
  const packOutput = run(
    npmCommand,
    ["pack", "--json", "--silent", "--pack-destination", temporaryDirectory],
    packageDirectory,
  );
  const [packed] = JSON.parse(packOutput);
  assert.ok(packed?.filename, "npm pack did not report a tarball filename");

  const packedFiles = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/server.js",
    "dist/analyzer.mjs",
    "dist/workspace-index.mjs",
    "assets/tree-sitter-stylus.wasm",
    "package.json",
    "README.md",
    "LICENSE",
  ]) {
    assert.ok(packedFiles.has(required), `npm package is missing ${required}`);
  }
  assert.ok(
    [...packedFiles].every(
      (file) => !file.startsWith("src/") && !file.startsWith("tests/"),
    ),
    "npm package contains development sources or tests",
  );

  const installDirectory = path.join(temporaryDirectory, "consumer");
  await fs.mkdir(installDirectory);
  await fs.writeFile(
    path.join(installDirectory, "package.json"),
    JSON.stringify({ private: true }),
  );
  const tarball = path.join(temporaryDirectory, packed.filename);
  run(
    npmCommand,
    ["install", "--silent", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    installDirectory,
  );

  const installedServer = path.join(
    installDirectory,
    "node_modules",
    "stylus-lsp",
    "dist",
    "server.js",
  );
  const child = spawn(process.execPath, [installedServer, "--stdio"], {
    cwd: installDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readResponse = responseReader(child);

  const rootUri = pathToFileURL(installDirectory).href;
  const initializeResponse = readResponse(1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "package-smoke" }],
      capabilities: {},
    },
  });
  const initialize = await initializeResponse;
  assert.equal(initialize.result.capabilities.definitionProvider, true);

  const shutdownResponse = readResponse(2);
  send(child, { jsonrpc: "2.0", id: 2, method: "shutdown" });
  await shutdownResponse;
  send(child, { jsonrpc: "2.0", method: "exit" });
  await new Promise((resolve) => child.once("exit", resolve));

  console.log(`Packed, installed, and launched stylus-lsp@${packed.version}`);
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
