import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { filePathToUri } from "../src/analyzer.mjs";

const SERVER_PATH = fileURLToPath(new URL("../dist/server.js", import.meta.url));

async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

class TestClient {
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Map();
    this.notificationWaiters = new Map();
    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (!Number.isFinite(length) || this.buffer.length < end) {
        return;
      }
      const message = JSON.parse(this.buffer.subarray(start, end).toString("utf8"));
      this.buffer = this.buffer.subarray(end);

      if (message.method && Object.hasOwn(message, "id")) {
        this.send({ jsonrpc: "2.0", id: message.id, result: null });
        continue;
      }
      if (message.method) {
        const waiters = this.notificationWaiters.get(message.method) ?? [];
        const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message.params));
        if (waiterIndex !== -1) {
          const [waiter] = waiters.splice(waiterIndex, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message.params);
        } else {
          const notifications = this.notifications.get(message.method) ?? [];
          notifications.push(message.params);
          this.notifications.set(message.method, notifications);
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  send(message) {
    const json = JSON.stringify(message);
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitForNotification(method, predicate = () => true, timeoutMs = 5_000) {
    const notifications = this.notifications.get(method) ?? [];
    const notificationIndex = notifications.findIndex(predicate);
    if (notificationIndex !== -1) {
      const [notification] = notifications.splice(notificationIndex, 1);
      return Promise.resolve(notification);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.notificationWaiters.get(method) ?? [];
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${method}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
      this.notificationWaiters.set(method, waiters);
    });
  }
}

test("serves the complete language workflow over stdio", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stylus-lsp-protocol-"));
  const definitionPath = await writeFile(root, "tokens.styl", "$brand = #123456\n");
  const usage = `@import "./tokens"
.card
  color $brand
  background $br
`;
  const usagePath = await writeFile(root, "main.styl", usage);

  const child = spawn(process.execPath, [SERVER_PATH, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  });
  const client = new TestClient(child);
  const rootUri = filePathToUri(root);

  const initialize = await client.request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "fixture" }],
    capabilities: {
      workspace: {
        didChangeWatchedFiles: { dynamicRegistration: true },
        workspaceFolders: true,
      },
    },
  });
  assert.equal(initialize.capabilities.definitionProvider, true);
  assert.equal(initialize.capabilities.referencesProvider, true);
  assert.deepEqual(initialize.capabilities.renameProvider, { prepareProvider: true });
  assert.ok(initialize.capabilities.completionProvider);

  client.notify("initialized");
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: filePathToUri(usagePath),
      languageId: "stylus",
      version: 1,
      text: usage,
    },
  });
  const definition = await client.request("textDocument/definition", {
    textDocument: { uri: filePathToUri(usagePath) },
    position: { line: 2, character: 10 },
  });
  assert.equal(definition.uri, filePathToUri(definitionPath));
  assert.deepEqual(definition.range.start, { line: 0, character: 0 });

  const references = await client.request("textDocument/references", {
    textDocument: { uri: filePathToUri(usagePath) },
    position: { line: 2, character: 10 },
    context: { includeDeclaration: true },
  });
  assert.equal(references.length, 2);

  const prepared = await client.request("textDocument/prepareRename", {
    textDocument: { uri: filePathToUri(usagePath) },
    position: { line: 2, character: 10 },
  });
  assert.equal(prepared.placeholder, "$brand");

  const completion = await client.request("textDocument/completion", {
    textDocument: { uri: filePathToUri(usagePath) },
    position: { line: 3, character: 16 },
  });
  assert.ok(completion.items.some((item) => item.label === "$brand"));

  const rename = await client.request("textDocument/rename", {
    textDocument: { uri: filePathToUri(usagePath) },
    position: { line: 2, character: 10 },
    newName: "$primary",
  });
  assert.equal(rename.changes[filePathToUri(definitionPath)].length, 1);
  assert.equal(rename.changes[filePathToUri(usagePath)].length, 1);

  const changed = `@import "./tokens"
.card
  color $brand
  background $missing
`;
  const diagnosticsPromise = client.waitForNotification(
    "textDocument/publishDiagnostics",
    (params) =>
      params.uri === filePathToUri(usagePath) &&
      params.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "stylus.unknown-variable" &&
          diagnostic.message.includes("$missing"),
      ),
  );
  client.notify("textDocument/didChange", {
    textDocument: { uri: filePathToUri(usagePath), version: 2 },
    contentChanges: [{ text: changed }],
  });
  const published = await diagnosticsPromise;
  assert.ok(
    published.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "stylus.unknown-variable" &&
        diagnostic.message.includes("$missing"),
    ),
  );

  const deletedImportDiagnostics = client.waitForNotification(
    "textDocument/publishDiagnostics",
    (params) =>
      params.uri === filePathToUri(usagePath) &&
      params.diagnostics.some(
        (diagnostic) => diagnostic.code === "stylus.unresolved-import",
      ),
  );
  await fs.unlink(definitionPath);
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: filePathToUri(definitionPath), type: 3 }],
  });
  const afterDelete = await deletedImportDiagnostics;
  assert.ok(
    afterDelete.diagnostics.some(
      (diagnostic) => diagnostic.code === "stylus.unresolved-import",
    ),
  );

  await client.request("shutdown");
  client.notify("exit");
  await new Promise((resolve) => child.once("exit", resolve));
});
