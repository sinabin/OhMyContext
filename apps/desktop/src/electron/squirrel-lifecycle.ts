import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  CodexConfigMutationResult,
  CodexConfigService,
  OwnContextMcpLaunch,
} from "./codex-config.js";

export type SquirrelEvent = "install" | "updated" | "uninstall" | "obsolete";
export type SquirrelStage =
  | "config-service"
  | "launch"
  | "refresh-managed"
  | "remove-managed"
  | "create-shortcut"
  | "remove-shortcut";

export interface SquirrelFailure {
  stage: SquirrelStage;
  code: string;
}

export interface SquirrelLifecycleReport {
  event: SquirrelEvent;
  failures: readonly SquirrelFailure[];
}

export interface SquirrelLifecycleOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  argv: readonly string[];
  executablePath: string;
  createConfigService: () => CodexConfigService;
  createLaunch: () => OwnContextMcpLaunch;
  runUpdate: (args: readonly string[]) => Promise<void>;
  quit: () => void;
  reportFailure?: (failure: SquirrelFailure) => void;
}

export type SquirrelLifecycleStart =
  | { handled: false }
  | { handled: true; completion: Promise<SquirrelLifecycleReport> };

const EVENT_BY_ARGUMENT = new Map<string, SquirrelEvent>([
  ["--squirrel-install", "install"],
  ["--squirrel-updated", "updated"],
  ["--squirrel-uninstall", "uninstall"],
  ["--squirrel-obsolete", "obsolete"],
]);

export function detectSquirrelEvent(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  argv: readonly string[],
): SquirrelEvent | undefined {
  if (platform !== "win32" || !isPackaged) return undefined;
  return EVENT_BY_ARGUMENT.get(argv[1] ?? "");
}

function mutationFailureCode(result: CodexConfigMutationResult): string | undefined {
  return result.ok ? undefined : result.code;
}

export function beginSquirrelLifecycle(
  options: SquirrelLifecycleOptions,
): SquirrelLifecycleStart {
  const event = detectSquirrelEvent(
    options.platform,
    options.isPackaged,
    options.argv,
  );
  if (!event) return { handled: false };

  const completion = (async (): Promise<SquirrelLifecycleReport> => {
    const failures: SquirrelFailure[] = [];
    const recordFailure = (stage: SquirrelStage, code = "operation_failed"): void => {
      const failure = { stage, code };
      failures.push(failure);
      try {
        options.reportFailure?.(failure);
      } catch {
        // Diagnostics must never keep a Squirrel event process alive.
      }
    };
    const attempt = async <T>(
      stage: SquirrelStage,
      operation: () => T | Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      try {
        return { ok: true, value: await operation() };
      } catch {
        recordFailure(stage);
        return { ok: false };
      }
    };
    const shortcutTarget = basename(options.executablePath);

    try {
      if (event === "install") {
        await attempt("create-shortcut", () =>
          options.runUpdate([`--createShortcut=${shortcutTarget}`]),
        );
      } else if (event === "updated") {
        const service = await attempt("config-service", options.createConfigService);
        const launch = await attempt("launch", options.createLaunch);
        if (service.ok && launch.ok) {
          const refreshed = await attempt("refresh-managed", () =>
            service.value.refreshManaged(launch.value),
          );
          if (refreshed.ok) {
            const failureCode = mutationFailureCode(refreshed.value);
            if (failureCode) recordFailure("refresh-managed", failureCode);
          }
        }
        await attempt("create-shortcut", () =>
          options.runUpdate([`--createShortcut=${shortcutTarget}`]),
        );
      } else if (event === "uninstall") {
        const service = await attempt("config-service", options.createConfigService);
        if (service.ok) {
          const removed = await attempt("remove-managed", () =>
            service.value.remove(),
          );
          if (removed.ok) {
            const failureCode = mutationFailureCode(removed.value);
            if (failureCode) recordFailure("remove-managed", failureCode);
          }
        }
        await attempt("remove-shortcut", () =>
          options.runUpdate([`--removeShortcut=${shortcutTarget}`]),
        );
      }
    } finally {
      try {
        options.quit();
      } catch {
        // There is no safe follow-up action after Electron rejects app.quit().
      }
    }

    return { event, failures };
  })();

  return { handled: true, completion };
}

export function createSquirrelUpdateRunner(
  executablePath: string,
  timeoutMilliseconds = 15_000,
): (args: readonly string[]) => Promise<void> {
  if (!isAbsolute(executablePath) || timeoutMilliseconds < 1) {
    throw new Error("Invalid Squirrel Update.exe runner configuration.");
  }
  const updateExecutable = resolve(dirname(executablePath), "..", "Update.exe");

  return async (args): Promise<void> => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(updateExecutable, [...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timer = setTimeout(() => {
        child.kill();
        settle(new Error("Squirrel Update.exe timed out."));
      }, timeoutMilliseconds);
      child.once("error", () => settle(new Error("Cannot start Squirrel Update.exe.")));
      child.once("close", (code, signal) => {
        if (code === 0) settle();
        else {
          settle(
            new Error(
              signal
                ? `Squirrel Update.exe stopped with signal ${signal}.`
                : `Squirrel Update.exe exited with code ${String(code)}.`,
            ),
          );
        }
      });
    });
  };
}
