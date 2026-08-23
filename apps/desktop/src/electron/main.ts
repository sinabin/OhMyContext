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
  clearRetrievalActivity,
  commitPreparedDirectoryImport,
  DirectoryImportScopeChangedError,
  fetchDocument,
  importOwnContextSampleLibrary,
  listDeletionReceipts,
  listRetrievalActivity,
  listSources,
  openVault,
  prepareDirectoryImport,
  prepareSourcePurge,
  purgeSource,
  searchVault,
  verifyDeletionReceipt,
  type ImportProgress,
  type PreparedDirectoryImport,
  type PurgeSourceInput,
  type Vault,
} from "@owncontext/core";
import {
  DIRECTORY_IMPORT_TOKEN_TTL_MS,
  DirectoryImportTokenManager,
  isValidDirectoryImportToken,
  renderImportResult,
} from "./directory-import-preflight.js";
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
  prepareEncryptedVaultSmoke,
  runEncryptedVaultSmoke,
} from "./encrypted-vault-smoke.js";
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
let folderSelectionActive = false;
let quitAfterImport = false;
let trustedRendererWebContentsId: number | undefined;
const directoryImportTokens = new DirectoryImportTokenManager<PreparedDirectoryImport>();

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

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (
    error === signal.reason ||
    (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    )
  );
}

async function runSampleVaultImport(
  event: IpcMainInvokeEvent,
  selectedPath: string,
  suggestedQuery: string,
) {
  if (activeImport) {
    throw new Error("An import is already running.");
  }

  const controller = new AbortController();
  activeImport = controller;
  try {
    const onProgress = (progress: ImportProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("vault:import-progress", progress);
      }
    };
    const result = await importOwnContextSampleLibrary(requireVault(), selectedPath, {
      signal: controller.signal,
      onProgress,
    });
    return {
      canceled: false as const,
      aborted: false as const,
      sample: true as const,
      suggestedQuery,
      result,
    };
  } catch (error) {
    if (isAbortFailure(error, controller.signal)) {
      return {
        canceled: false as const,
        aborted: true as const,
        sample: true as const,
        suggestedQuery,
      };
    }
    return {
      canceled: false as const,
      aborted: false as const,
      failed: true as const,
      sample: true as const,
      suggestedQuery,
    };
  } finally {
    activeImport = undefined;
    finishDeferredQuitOrClose();
  }
}

async function prepareFolderImport(
  event: IpcMainInvokeEvent,
  selectedPath: string,
): Promise<
  | {
      status: "ready";
      token: string;
      folderLabel: string;
      preview: PreparedDirectoryImport["preview"];
    }
  | { status: "aborted" }
  | { status: "failed" }
> {
  if (activeImport) throw new Error("An import or import scan is already running.");
  const controller = new AbortController();
  activeImport = controller;

  try {
    const prepared = await prepareDirectoryImport(selectedPath, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("vault:import-progress", progress);
        }
      },
    });
    if (controller.signal.aborted || event.sender.isDestroyed()) {
      return { status: "aborted" };
    }
    const token = directoryImportTokens.issue(event.sender.id, prepared);
    const expiryTimer = setTimeout(() => {
      directoryImportTokens.expireIfDue(token);
    }, DIRECTORY_IMPORT_TOKEN_TTL_MS);
    expiryTimer.unref();
    return {
      status: "ready",
      token,
      folderLabel: prepared.preview.sourceName,
      preview: prepared.preview,
    };
  } catch (error) {
    if (isAbortFailure(error, controller.signal)) return { status: "aborted" };
    return { status: "failed" };
  } finally {
    activeImport = undefined;
    finishDeferredQuitOrClose();
  }
}

async function commitPreparedFolderImport(
  event: IpcMainInvokeEvent,
  token: string,
  prepared: PreparedDirectoryImport,
) {
  const controller = new AbortController();
  activeImport = controller;
  try {
    const result = await commitPreparedDirectoryImport(requireVault(), prepared, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("vault:import-progress", progress);
        }
      },
    });
    directoryImportTokens.markImported(token);
    return {
      status: "imported" as const,
      replayed: false as const,
      result: renderImportResult(result),
    };
  } catch (error) {
    if (error instanceof DirectoryImportScopeChangedError || (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "IMPORT_SCOPE_CHANGED"
    )) {
      directoryImportTokens.markStale(token);
      return { status: "stale-scan" as const };
    }
    if (isAbortFailure(error, controller.signal)) {
      directoryImportTokens.markAborted(token);
      return { status: "aborted" as const };
    }
    directoryImportTokens.markAborted(token);
    return { status: "failed" as const };
  } finally {
    activeImport = undefined;
    finishDeferredQuitOrClose();
  }
}

function finishDeferredQuitOrClose(): void {
  if (quitAfterImport) {
    quitAfterImport = false;
    closeVault();
    app.quit();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    closeVault();
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
    directoryImportTokens.abortPendingForSender(windowWebContentsId);
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

    ipcMain.handle("vault:prepare-directory-import", async (event) => {
      const parentWindow = trustedWindowFor(event);
      if (activeImport || folderSelectionActive) {
        return { status: "busy" as const };
      }
      directoryImportTokens.abortPendingForSender(event.sender.id);
      folderSelectionActive = true;
      try {
        const selection = await dialog.showOpenDialog(parentWindow, {
          title: "Choose a folder you are authorized to import",
          properties: ["openDirectory"],
        });

        const selectedPath = selection.filePaths[0];
        if (selection.canceled || !selectedPath) {
          return { status: "canceled" as const };
        }
        if (activeImport) return { status: "busy" as const };
        return prepareFolderImport(event, selectedPath);
      } finally {
        folderSelectionActive = false;
      }
    });

    ipcMain.handle("vault:confirm-directory-import", async (event, token: unknown) => {
      trustedWindowFor(event);
      if (activeImport || folderSelectionActive) return { status: "busy" as const };
      const confirmation = directoryImportTokens.takeForConfirmation(token, event.sender.id);
      if (confirmation.status !== "ready") {
        return confirmation.status === "imported"
          ? { status: "imported" as const, replayed: true as const }
          : { status: confirmation.status };
      }
      if (!isValidDirectoryImportToken(token)) {
        // The manager can return ready only for a valid token. Keep this local
        // assertion so no unvalidated renderer value reaches lifecycle methods.
        throw new Error("Validated directory import token was lost.");
      }
      if (!confirmation.prepared.preview.canImport) {
        directoryImportTokens.markAborted(token);
        return { status: "aborted" as const };
      }
      return commitPreparedFolderImport(event, token, confirmation.prepared);
    });

    ipcMain.handle("vault:cancel-directory-import", (event, token: unknown) => {
      trustedWindowFor(event);
      return directoryImportTokens.cancel(token, event.sender.id);
    });

    ipcMain.handle("vault:import-sample-library", async (event) => {
      trustedWindowFor(event);
      if (activeImport || folderSelectionActive) {
        throw new Error("An import is already running.");
      }
      directoryImportTokens.abortPendingForSender(event.sender.id);
      const sample = await materializeSampleLibrary(app.getPath("userData"));
      return runSampleVaultImport(event, sample.directoryPath, sample.suggestedQuery);
    });

    ipcMain.handle("vault:cancel-import", (event) => {
      trustedWindowFor(event);
      const requested = activeImport !== undefined;
      activeImport?.abort();
      return { requested };
    });

    ipcMain.handle("vault:search", (event, query: string) => {
      trustedWindowFor(event);
      return {
        results: searchVault(
          requireVault(),
          { query, limit: 12 },
          { clientKind: "desktop" },
        ),
      };
    });

    ipcMain.handle(
      "vault:fetch",
      (event, input: { documentId: string; chunkId: string }) => {
        trustedWindowFor(event);
        return fetchDocument(requireVault(), input, { clientKind: "desktop" });
      },
    );

    ipcMain.handle("vault:list-retrieval-activity", (event) => {
      trustedWindowFor(event);
      return {
        entries: listRetrievalActivity(requireVault(), { limit: 100 }),
      };
    });

    ipcMain.handle("vault:clear-retrieval-activity", async (event) => {
      const parentWindow = trustedWindowFor(event);
      const confirmation = await dialog.showMessageBox(parentWindow, {
        type: "warning",
        title: "Clear local access history?",
        message: "Clear OwnContext's local access history?",
        detail:
          "This removes only the content-free history stored in this local vault. " +
          "It cannot retract context already returned to an AI client or retained by its provider.",
        buttons: ["Keep history", "Clear local history"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) {
        return { status: "canceled" as const };
      }
      return {
        status: "cleared" as const,
        deleted: clearRetrievalActivity(requireVault()),
      };
    });

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
    directoryImportTokens.abortAll();
    if (activeImport) {
      event.preventDefault();
      quitAfterImport = true;
      activeImport.abort();
    }
  });

  app.on("window-all-closed", () => {
    directoryImportTokens.abortAll();
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
  const encryptedVaultSmoke = prepareEncryptedVaultSmoke();
  if (encryptedVaultSmoke) {
    app.setPath("userData", encryptedVaultSmoke.userDataPath);
    // Keep this normal-Electron verification in the main process so the
    // packaged run exercises async safeStorage and the shipped native module.
    void app.whenReady()
      .then(() => runEncryptedVaultSmoke(
        encryptedVaultSmoke,
        safeStorage,
        app.isPackaged,
        process.resourcesPath,
      ))
      .then(() => app.exit(0))
      .catch(() => {
        process.stderr.write("OwnContext encrypted-vault verification failed.\n");
        app.exit(1);
      });
    return;
  }

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
