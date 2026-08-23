import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import {
  createNodeSqliteDevelopmentStorageProvider,
  fetchDocument,
  importDirectory,
  importOwnContextSampleLibrary,
  listDeletionReceipts,
  listSources,
  openVault,
  prepareSourcePurge,
  purgeSource,
  searchVault,
  verifyDeletionReceipt,
  type ImportProgress,
  type PurgeSourceInput,
  type Vault,
} from "@owncontext/core";
import {
  createCodexConfigService,
  type CodexConfigService,
  type OwnContextMcpLaunch,
} from "./codex-config.js";
import {
  createClaudeCodeConfigService,
  type ClaudeCodeConfigService,
  type ClaudeCodeMcpLaunch,
} from "./claude-code-config.js";
import { isTrustedIpcSender } from "./ipc-trust.js";
import {
  prepareKeyStorageSmoke,
  runKeyStorageSmoke,
} from "./key-storage-smoke.js";
import {
  prepareGuiSmoke,
  runGuiSmokeJourney,
  writeGuiSmokeSuccess,
  type GuiSmokeContext,
} from "./gui-smoke.js";
import {
  beginSquirrelLifecycle,
  createSquirrelUpdateRunner,
} from "./squirrel-lifecycle.js";
import { materializeSampleLibrary } from "./sample-library.js";
import {
  omitConnectionMutationSnippet,
  renderRendererSafeClaudeCodePreview,
  renderRendererSafeCodexPreview,
} from "./renderer-connection-preview.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
let vault: Vault | undefined;
let activeImport: AbortController | undefined;
let quitAfterImport = false;
let trustedRendererWebContentsId: number | undefined;

function rendererEntryPath(): string {
  return join(moduleDirectory, "../dist/renderer/index.html");
}

function trustedWindowFor(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (
    !window ||
    !isTrustedIpcSender({
      trustedWebContentsId: trustedRendererWebContentsId,
      senderWebContentsId: event.sender.id,
      isMainFrame: frame === event.sender.mainFrame,
      senderUrl: frame?.url ?? "",
      expectedUrl: pathToFileURL(rendererEntryPath()).href,
    })
  ) {
    throw new Error("OwnContext rejected an untrusted IPC sender.");
  }
  return window;
}

function databasePath(): string {
  return join(app.getPath("userData"), "owncontext.sqlite");
}

function requireVault(): Vault {
  if (!vault) {
    vault = openVault(
      databasePath(),
      createNodeSqliteDevelopmentStorageProvider(),
    );
  }

  return vault;
}

function closeVault(): void {
  vault?.close();
  vault = undefined;
}

function mcpEntryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "mcp-server", "cli.mjs")
    : join(app.getAppPath(), "..", "mcp-server", "dist", "cli.js");
}

function ownContextMcpLaunch(): OwnContextMcpLaunch & ClaudeCodeMcpLaunch {
  return {
    commandPath: process.execPath,
    args: [mcpEntryPath()],
    vaultPath: databasePath(),
    allowedCollection: "default",
    runtime: "electron",
  };
}

interface VaultImportOptions {
  collection?: string;
  sourceName?: string;
  exposeSelectedPath?: boolean;
  sample?: boolean;
  suggestedQuery?: string;
  builtInSample?: true;
}

async function runVaultImport(
  event: IpcMainInvokeEvent,
  selectedPath: string,
  options: VaultImportOptions = {},
) {
  if (activeImport) {
    throw new Error("An import is already running.");
  }

  const controller = new AbortController();
  activeImport = controller;
  const publicMetadata = {
    ...(options.exposeSelectedPath === false ? {} : { selectedPath }),
    ...(options.sample === true ? { sample: true as const } : {}),
    ...(options.suggestedQuery ? { suggestedQuery: options.suggestedQuery } : {}),
  };

  try {
    const onProgress = (progress: ImportProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("vault:import-progress", progress);
      }
    };
    const result = options.builtInSample
      ? await importOwnContextSampleLibrary(requireVault(), selectedPath, {
          signal: controller.signal,
          onProgress,
        })
      : await importDirectory(requireVault(), selectedPath, {
          ...(options.collection ? { collection: options.collection } : {}),
          ...(options.sourceName ? { sourceName: options.sourceName } : {}),
          signal: controller.signal,
          onProgress,
        });
    return {
      canceled: false as const,
      aborted: false as const,
      ...publicMetadata,
      result,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        canceled: false as const,
        aborted: true as const,
        ...publicMetadata,
      };
    }
    throw error;
  } finally {
    activeImport = undefined;
    if (quitAfterImport) {
      quitAfterImport = false;
      closeVault();
      app.quit();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      closeVault();
    }
  }
}

function armGuiSmoke(window: BrowserWindow, context: GuiSmokeContext): void {
  let finished = false;
  const finishWithFailure = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    app.exit(2);
  };
  // Leave bounded headroom for a cold packaged renderer load before the
  // journey's own 18-second execution deadline.
  const timeout = setTimeout(finishWithFailure, 25_000);

  window.webContents.once("did-fail-load", finishWithFailure);
  window.webContents.once("did-finish-load", () => {
    void runGuiSmokeJourney(window.webContents)
      .then((evidence) => {
        if (finished) return;
        writeGuiSmokeSuccess(context, app.isPackaged, evidence);
        finished = true;
        clearTimeout(timeout);
        app.exit(0);
      })
      .catch(finishWithFailure);
  });
}

function createWindow(guiSmoke?: GuiSmokeContext): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f4f1ea",
    title: "OwnContext Developer Preview",
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const expectedUrl = pathToFileURL(rendererEntryPath()).href;
  const windowWebContentsId = window.webContents.id;
  trustedRendererWebContentsId = windowWebContentsId;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== expectedUrl) event.preventDefault();
  });
  window.once("closed", () => {
    if (trustedRendererWebContentsId === windowWebContentsId) {
      trustedRendererWebContentsId = undefined;
    }
  });
  if (guiSmoke) armGuiSmoke(window, guiSmoke);
  void window.loadFile(rendererEntryPath());
  return window;
}

function startDesktopApp(
  codexConfig: CodexConfigService,
  claudeCodeConfig: ClaudeCodeConfigService,
  guiSmoke?: GuiSmokeContext,
): void {
  void app.whenReady().then(() => {
    ipcMain.handle("vault:status", (event) => {
      trustedWindowFor(event);
      return {
        ready: true,
        mode: "Local vault + bounded AI context and provenance",
        encryption: "not-implemented" as const,
      };
    });

    ipcMain.handle("vault:import-directory", async (event) => {
      const parentWindow = trustedWindowFor(event);
      if (activeImport) {
        throw new Error("An import is already running.");
      }

      const selection = await dialog.showOpenDialog(parentWindow, {
        title: "Choose a folder you are authorized to import",
        properties: ["openDirectory"],
      });

      const selectedPath = selection.filePaths[0];
      if (selection.canceled || !selectedPath) {
        return { canceled: true, aborted: false };
      }

      return runVaultImport(event, selectedPath);
    });

    ipcMain.handle("vault:import-sample-library", async (event) => {
      trustedWindowFor(event);
      if (activeImport) {
        throw new Error("An import is already running.");
      }
      const sample = await materializeSampleLibrary(app.getPath("userData"));
      return runVaultImport(event, sample.directoryPath, {
        exposeSelectedPath: false,
        sample: true,
        suggestedQuery: sample.suggestedQuery,
        builtInSample: true,
      });
    });

    ipcMain.handle("vault:cancel-import", (event) => {
      trustedWindowFor(event);
      const requested = activeImport !== undefined;
      activeImport?.abort();
      return { requested };
    });

    ipcMain.handle("vault:search", (event, query: string) => {
      trustedWindowFor(event);
      return { results: searchVault(requireVault(), { query, limit: 12 }) };
    });

    ipcMain.handle(
      "vault:fetch",
      (event, input: { documentId: string; chunkId: string }) => {
        trustedWindowFor(event);
        return fetchDocument(requireVault(), input);
      },
    );

    ipcMain.handle("vault:list-sources", (event) => {
      trustedWindowFor(event);
      return { sources: listSources(requireVault()) };
    });

    ipcMain.handle("vault:prepare-source-purge", (event, sourceId: string) => {
      trustedWindowFor(event);
      return prepareSourcePurge(requireVault(), sourceId);
    });

    ipcMain.handle("vault:purge-source", async (event, input: PurgeSourceInput) => {
      const parentWindow = trustedWindowFor(event);
      const prepared = prepareSourcePurge(requireVault(), input.sourceId);
      if (prepared.status !== "ready") return prepared;
      if (
        prepared.preview.confirmationToken !== input.confirmationToken ||
        prepared.preview.documentCount !== input.expectedDocumentCount ||
        prepared.preview.lastScannedAt !== input.expectedLastScannedAt
      ) {
        return { status: "stale-confirmation" as const };
      }

      const confirmation = await dialog.showMessageBox(parentWindow, {
        type: "warning",
        title: "Confirm OwnContext removal",
        message: `Remove “${prepared.preview.name}” from OwnContext?`,
        detail:
          `This removes ${prepared.preview.documentCount} indexed document(s) and their stored lineage. ` +
          "The original folder remains unchanged.",
        buttons: ["Keep source", "Remove local copy"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) {
        return { status: "canceled" as const };
      }
      return purgeSource(requireVault(), input);
    });

    ipcMain.handle("vault:list-deletion-receipts", (event) => {
      trustedWindowFor(event);
      const activeVault = requireVault();
      return {
        receipts: listDeletionReceipts(activeVault, 3).map((receipt) => ({
          ...receipt,
          verificationStatus: verifyDeletionReceipt(activeVault, receipt.receiptId).status,
        })),
      };
    });

    ipcMain.handle("connection:codex-preview", async (event) => {
      trustedWindowFor(event);
      const serverReady = existsSync(mcpEntryPath());
      const launch = ownContextMcpLaunch();
      const preview = await codexConfig.preview(launch);
      return {
        ...preview,
        snippet: renderRendererSafeCodexPreview(launch),
        allowedCollection: launch.allowedCollection,
        canApply: preview.canApply && serverReady,
        serverReady,
      };
    });

    ipcMain.handle("connection:codex-apply", async (event) => {
      trustedWindowFor(event);
      if (!existsSync(mcpEntryPath())) {
        return {
          ok: false,
          code: "server_unavailable",
          changed: false,
          backupCreated: false,
        };
      }
      return omitConnectionMutationSnippet(
        await codexConfig.apply(ownContextMcpLaunch()),
      );
    });

    ipcMain.handle("connection:codex-remove", async (event) => {
      trustedWindowFor(event);
      return omitConnectionMutationSnippet(await codexConfig.remove());
    });

    ipcMain.handle("connection:claude-code-preview", async (event) => {
      trustedWindowFor(event);
      const serverReady = existsSync(mcpEntryPath());
      const launch = ownContextMcpLaunch();
      const preview = await claudeCodeConfig.preview(launch);
      return {
        ...preview,
        snippet: renderRendererSafeClaudeCodePreview(launch),
        allowedCollection: launch.allowedCollection,
        canApply: preview.canApply && serverReady,
        serverReady,
      };
    });

    ipcMain.handle("connection:claude-code-apply", async (event) => {
      trustedWindowFor(event);
      if (!existsSync(mcpEntryPath())) {
        return {
          ok: false,
          code: "server_unavailable",
          changed: false,
          backupCreated: false,
        };
      }
      return omitConnectionMutationSnippet(
        await claudeCodeConfig.apply(ownContextMcpLaunch()),
      );
    });

    ipcMain.handle("connection:claude-code-remove", async (event) => {
      trustedWindowFor(event);
      return omitConnectionMutationSnippet(await claudeCodeConfig.remove());
    });

    createWindow(guiSmoke);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("before-quit", (event) => {
    if (activeImport) {
      event.preventDefault();
      quitAfterImport = true;
      activeImport.abort();
    }
  });

  app.on("window-all-closed", () => {
    activeImport?.abort();
    if (!activeImport) closeVault();

    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

app.setAppUserModelId(
  "com.squirrel.OwnContextDeveloperPreview.OwnContextDeveloperPreview",
);

async function bootstrap(): Promise<void> {
  const keyStorageSmoke = prepareKeyStorageSmoke();
  if (keyStorageSmoke) {
    app.setPath("userData", keyStorageSmoke.userDataPath);
    // Electron does not emit `ready` until main-module evaluation finishes.
    // Register the continuation and return instead of top-level-awaiting the
    // readiness promise, which would deadlock the packaged smoke process.
    void app.whenReady()
      .then(() => runKeyStorageSmoke(keyStorageSmoke, safeStorage, app.isPackaged))
      .then(() => app.exit(0))
      .catch(() => {
        process.stderr.write("OwnContext key-storage verification failed.\n");
        app.exit(1);
      });
    return;
  }

  const guiSmoke = prepareGuiSmoke();
  if (guiSmoke) {
    app.setPath("userData", guiSmoke.userDataPath);
  }

  const squirrel = beginSquirrelLifecycle({
    platform: process.platform,
    isPackaged: app.isPackaged,
    argv: process.argv,
    executablePath: process.execPath,
    createConfigService: () => createCodexConfigService(),
    createClaudeCodeConfigService: () => createClaudeCodeConfigService(),
    createLaunch: () => {
      if (!existsSync(mcpEntryPath())) {
        throw new Error("Packaged MCP runtime is unavailable.");
      }
      return ownContextMcpLaunch();
    },
    runUpdate: createSquirrelUpdateRunner(process.execPath),
    quit: () => app.quit(),
    reportFailure: ({ stage, code }) => {
      process.stderr.write(`Squirrel lifecycle ${stage} failed (${code}).\n`);
    },
  });
  if (squirrel.handled) {
    await squirrel.completion;
    return;
  }

  // Squirrel install/update/uninstall hooks must run even while the regular app
  // is open. Normal interactive launches use one process so a second desktop
  // instance cannot race an import against a confirmed source purge.
  if (!guiSmoke) {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    app.on("second-instance", () => {
      const existingWindow = BrowserWindow.getAllWindows()[0];
      if (!existingWindow) return;
      if (existingWindow.isMinimized()) existingWindow.restore();
      existingWindow.show();
      existingWindow.focus();
    });
  }

  const codexConfig = createCodexConfigService(
    guiSmoke ? { configPath: guiSmoke.codexConfigPath } : {},
  );
  const claudeCodeConfig = createClaudeCodeConfigService(
    guiSmoke ? { configPath: guiSmoke.claudeCodeConfigPath } : {},
  );
  startDesktopApp(codexConfig, claudeCodeConfig, guiSmoke);
}

try {
  await bootstrap();
} catch {
  process.stderr.write("OwnContext desktop startup failed.\n");
  app.exit(1);
}
