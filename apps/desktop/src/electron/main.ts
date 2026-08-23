import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  fetchDocument,
  importDirectory,
  listSources,
  openVault,
  searchVault,
  type Vault,
} from "@owncontext/core";
import {
  createCodexConfigService,
  type CodexConfigService,
  type OwnContextMcpLaunch,
} from "./codex-config.js";
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

  if (guiSmoke) armGuiSmoke(window, guiSmoke);
  void window.loadFile(join(moduleDirectory, "../dist/renderer/index.html"));
  return window;
}

function startDesktopApp(
  codexConfig: CodexConfigService,
  guiSmoke?: GuiSmokeContext,
): void {
  void app.whenReady().then(() => {
    ipcMain.handle("vault:status", () => ({
      ready: true,
      mode: "Local vault + selected AI excerpts",
      encryption: "not-implemented" as const,
    }));

    ipcMain.handle("vault:import-directory", async (event) => {
      if (activeImport) {
        throw new Error("An import is already running.");
      }

      const selection = await dialog.showOpenDialog({
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

    ipcMain.handle("vault:cancel-import", () => {
      const requested = activeImport !== undefined;
      activeImport?.abort();
      return { requested };
    });

    ipcMain.handle("vault:search", (_event, query: string) => {
      return { results: searchVault(requireVault(), { query, limit: 12 }) };
    });

    ipcMain.handle(
      "vault:fetch",
      (_event, input: { documentId: string; chunkId: string }) => {
        return fetchDocument(requireVault(), input);
      },
    );

    ipcMain.handle("vault:list-sources", () => ({
      sources: listSources(requireVault()),
    }));

    ipcMain.handle("connection:codex-preview", async () => {
      const serverReady = existsSync(mcpEntryPath());
      const preview = await codexConfig.preview(codexLaunch());
      return {
        ...preview,
        canApply: preview.canApply && serverReady,
        serverReady,
      };
    });

    ipcMain.handle("connection:codex-apply", async () => {
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

    ipcMain.handle("connection:codex-remove", () => codexConfig.remove());

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
