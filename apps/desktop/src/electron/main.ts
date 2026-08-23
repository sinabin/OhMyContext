import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import {
  fetchDocument,
  importDirectory,
  listDeletionReceipts,
  listSources,
  openVault,
  prepareSourcePurge,
  purgeSource,
  searchVault,
  verifyDeletionReceipt,
  type PurgeSourceInput,
  type Vault,
} from "@owncontext/core";
import {
  createCodexConfigService,
  type CodexConfigService,
  type OwnContextMcpLaunch,
} from "./codex-config.js";
import { isTrustedIpcSender } from "./ipc-trust.js";
import {
  prepareGuiSmoke,
  writeGuiSmokeSuccess,
  type GuiSmokeContext,
} from "./gui-smoke.js";
import {
  beginSquirrelLifecycle,
  createSquirrelUpdateRunner,
} from "./squirrel-lifecycle.js";

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
    vault = openVault(databasePath());
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

function codexLaunch(): OwnContextMcpLaunch {
  return {
    commandPath: process.execPath,
    args: [mcpEntryPath()],
    vaultPath: databasePath(),
    runtime: "electron",
  };
}

function armGuiSmoke(window: BrowserWindow, context: GuiSmokeContext): void {
  let finished = false;
  const finishWithFailure = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    app.exit(2);
  };
  const timeout = setTimeout(finishWithFailure, 20_000);

  window.webContents.once("did-fail-load", finishWithFailure);
  window.webContents.once("did-finish-load", () => {
    const waitForRenderer = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const ready = await window.webContents.executeJavaScript(
          "Boolean(document.querySelector('.shell') && window.ownContext && typeof window.ownContext.getStatus === 'function')",
          true,
        );
        if (ready === true) return true;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      return false;
    };

    void waitForRenderer()
      .then((rendererReady: unknown) => {
        if (rendererReady !== true) {
          finishWithFailure();
          return;
        }
        writeGuiSmokeSuccess(context, app.isPackaged);
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
  guiSmoke?: GuiSmokeContext,
): void {
  void app.whenReady().then(() => {
    ipcMain.handle("vault:status", (event) => {
      trustedWindowFor(event);
      return {
        ready: true,
        mode: "Local vault + selected AI excerpts",
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

      const controller = new AbortController();
      activeImport = controller;
      try {
        const result = await importDirectory(requireVault(), selectedPath, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("vault:import-progress", progress);
            }
          },
        });
        return { canceled: false, aborted: false, selectedPath, result };
      } catch (error) {
        if (controller.signal.aborted) {
          return { canceled: false, aborted: true, selectedPath };
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
      const preview = await codexConfig.preview(codexLaunch());
      return {
        ...preview,
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
      return codexConfig.apply(codexLaunch());
    });

    ipcMain.handle("connection:codex-remove", (event) => {
      trustedWindowFor(event);
      return codexConfig.remove();
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
    createLaunch: () => {
      if (!existsSync(mcpEntryPath())) {
        throw new Error("Packaged MCP runtime is unavailable.");
      }
      return codexLaunch();
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
  startDesktopApp(codexConfig, guiSmoke);
}

try {
  await bootstrap();
} catch {
  process.stderr.write("OwnContext desktop startup failed.\n");
  app.exit(1);
}
