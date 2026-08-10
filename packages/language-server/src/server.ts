#!/usr/bin/env node

import {
  createConnection,
  CancellationToken,
  CompletionList,
  DidChangeWatchedFilesNotification,
  ErrorCodes,
  FileChangeType,
  InitializeParams,
  InitializeResult,
  Hover,
  LSPErrorCodes,
  ProposedFeatures,
  ResponseError,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createRequire } from "node:module";

import { RenameError, WorkspaceIndex, uriToFilePath } from "./analyzer.mjs";
import { BackgroundTaskSupervisor } from "./background-tasks.mjs";
import { DiagnosticsScheduler } from "./diagnostics-scheduler.mjs";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex();
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

let currentWorkspaceUris: string[] = [];
let supportsDynamicFileWatching = false;
let supportsWorkspaceFolders = false;
const configurationFilePattern = /^(?:vite|webpack|nuxt)\.config\.(?:[cm]?[jt]s)$/i;
const backgroundTasks = new BackgroundTaskSupervisor((label: string, error: unknown) =>
  connection.console.error(`Stylus ${label} failed: ${String(error)}`),
);

const diagnosticsScheduler = new DiagnosticsScheduler({
  openUris: () => index.openUris(),
  debounceMs: () => index.diagnosticsDebounceMs(),
  compute: (uri: string, signal: AbortSignal) => index.diagnostics(uri, signal),
  publish: (params: Parameters<typeof connection.sendDiagnostics>[0]) =>
    connection.sendDiagnostics(params),
  reportError: (uri: string, error: unknown) =>
    connection.console.error(
      `Failed to compute Stylus diagnostics for ${uri}: ${String(error)}`,
    ),
  versionForUri: (uri: string) => documents.get(uri)?.version,
});

function isWorkspaceMetadata(uri: string) {
  const filePath = uriToFilePath(uri);
  if (!filePath) {
    return false;
  }
  const fileName = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
  return (
    configurationFilePattern.test(fileName) ||
    fileName === "tsconfig.json" ||
    fileName === "jsconfig.json" ||
    fileName === "package.json" ||
    fileName === ".gitignore"
  );
}

function cancellationSignal(token: CancellationToken) {
  return {
    get aborted() {
      return token.isCancellationRequested;
    },
    get reason() {
      return new ResponseError(LSPErrorCodes.RequestCancelled, "Request cancelled");
    },
  };
}

function renameResponse(error: unknown): never {
  if (error instanceof RenameError) {
    throw new ResponseError(ErrorCodes.InvalidRequest, error.message);
  }
  throw error;
}

function scheduleDiagnosticsForUris(uris: Iterable<string>) {
  diagnosticsScheduler.schedule(uris);
}

function scheduleDiagnostics(changedUri: string) {
  scheduleDiagnosticsForUris(index.affectedUris(changedUri));
}

function logConfigurationMessages() {
  for (const message of index.configurationLogMessages()) {
    connection.console.warn(message);
  }
}

function rebuildInBackground(label: string) {
  void backgroundTasks.run(label, async () => {
    await index.rebuild();
    logConfigurationMessages();
  });
}

function workspaceUris(params: InitializeParams): string[] {
  if (params.workspaceFolders?.length) {
    return params.workspaceFolders.map((folder) => folder.uri).filter(Boolean);
  }
  return params.rootUri ? [params.rootUri] : [];
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  currentWorkspaceUris = workspaceUris(params);
  supportsDynamicFileWatching =
    params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
  supportsWorkspaceFolders = params.capabilities.workspace?.workspaceFolders === true;

  index.setRoots(currentWorkspaceUris);
  index.configure(params.initializationOptions ?? {});

  return {
    capabilities: {
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["$", "@", "/", "-", "."],
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","],
      },
      colorProvider: true,
      textDocumentSync: TextDocumentSyncKind.Incremental,
      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true,
        },
      },
    },
    serverInfo: {
      name: "stylus-language-server",
      version,
    },
  };
});

connection.onInitialized(async () => {
  rebuildInBackground("initial workspace indexing");

  if (supportsWorkspaceFolders) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      const current = new Set(currentWorkspaceUris);
      for (const removed of event.removed) {
        current.delete(removed.uri);
      }
      for (const added of event.added) {
        current.add(added.uri);
      }
      currentWorkspaceUris = [...current];
      index.setRoots(currentWorkspaceUris);
      rebuildInBackground("workspace-folder reindexing");
    });
  }

  if (!supportsDynamicFileWatching) {
    return;
  }

  await connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [
      { globPattern: "**/*.styl" },
      { globPattern: "**/*.stylus" },
      { globPattern: "**/*.vue" },
      { globPattern: "**/*.svelte" },
      { globPattern: "**/*.astro" },
      { globPattern: "**/{vite,webpack,nuxt}.config.{js,cjs,mjs,ts,cts,mts}" },
      { globPattern: "**/{tsconfig,jsconfig}.json" },
      { globPattern: "**/package.json" },
      { globPattern: "**/.gitignore" },
    ],
  });
});

connection.onDefinition((params, token) =>
  index.definition(params.textDocument.uri, params.position, cancellationSignal(token)),
);

connection.onReferences((params, token) =>
  index.references(
    params.textDocument.uri,
    params.position,
    params.context.includeDeclaration,
    cancellationSignal(token),
  ),
);

connection.onPrepareRename(async (params, token) => {
  try {
    return await index.prepareRename(
      params.textDocument.uri,
      params.position,
      cancellationSignal(token),
    );
  } catch (error) {
    return renameResponse(error);
  }
});

connection.onRenameRequest(async (params, token) => {
  try {
    return await index.rename(
      params.textDocument.uri,
      params.position,
      params.newName,
      cancellationSignal(token),
    );
  } catch (error) {
    return renameResponse(error);
  }
});

connection.onDocumentSymbol((params) => index.documentSymbols(params.textDocument.uri));

connection.onWorkspaceSymbol((params, token) =>
  index.workspaceSymbols(params.query, cancellationSignal(token)),
);

connection.onCompletion(
  async (params, token) =>
    (await index.completion(
      params.textDocument.uri,
      params.position,
      cancellationSignal(token),
    )) as CompletionList,
);

connection.onHover(
  async (params, token) =>
    (await index.hover(
      params.textDocument.uri,
      params.position,
      cancellationSignal(token),
    )) as Hover | null,
);

connection.onSignatureHelp((params, token) =>
  index.signatureHelp(params.textDocument.uri, params.position, cancellationSignal(token)),
);

connection.onDocumentColor((params) => index.documentColors(params.textDocument.uri));

connection.onColorPresentation((params) =>
  index.colorPresentations(params.color, params.range),
);

documents.onDidOpen((event) => {
  void backgroundTasks.run(`opening ${event.document.uri}`, async () => {
    await index.openDocument(event.document.uri, event.document.getText());
    scheduleDiagnostics(event.document.uri);
  });
});

documents.onDidChangeContent((event) => {
  void backgroundTasks.run(`updating ${event.document.uri}`, async () => {
    await index.changeDocument(event.document.uri, event.document.getText());
    scheduleDiagnostics(event.document.uri);
  });
});

documents.onDidClose((event) => {
  const affectedUris = index.affectedUris(event.document.uri);
  diagnosticsScheduler.cancel(event.document.uri);
  connection.sendDiagnostics({
    uri: event.document.uri,
    version: event.document.version,
    diagnostics: [],
  });
  void backgroundTasks.run(`closing ${event.document.uri}`, async () => {
    await index.closeDocument(event.document.uri);
    scheduleDiagnosticsForUris(affectedUris);
  });
});

connection.onDidChangeConfiguration((event) => {
  index.configure(event.settings ?? {});
  void backgroundTasks.run("configuration refresh", async () => {
    await index.refreshImports();
    for (const uri of index.openUris()) {
      scheduleDiagnostics(uri);
    }
  });
});

connection.onDidChangeWatchedFiles(async (event) => {
  for (const change of event.changes) {
    if (isWorkspaceMetadata(change.uri)) {
      await index.rebuild();
      for (const uri of index.openUris()) {
        scheduleDiagnostics(uri);
      }
      continue;
    }

    if (change.type === FileChangeType.Deleted) {
      const affectedUris = index.affectedUris(change.uri);
      await index.removeFileUri(change.uri);
      scheduleDiagnosticsForUris(affectedUris);
      continue;
    }

    const filePath = uriToFilePath(change.uri);
    if (filePath) {
      const existed = index.documentUris().includes(change.uri);
      await index.indexFile(filePath, { force: true });
      if (!existed) {
        await index.refreshUnresolvedImports();
      }
      scheduleDiagnostics(change.uri);
    }
  }
});

documents.listen(connection);
connection.listen();
