import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const GUI_SMOKE_ARGUMENT = "--owncontext-gui-smoke";
export const GUI_SMOKE_ROOT_ENV = "OWNCONTEXT_GUI_SMOKE_ROOT";
export const GUI_SMOKE_NONCE_ENV = "OWNCONTEXT_GUI_SMOKE_NONCE";

export interface GuiSmokeContext {
  rootPath: string;
  userDataPath: string;
  codexConfigPath: string;
  resultPath: string;
  nonce: string;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

export function prepareGuiSmoke(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  temporaryDirectory = tmpdir(),
): GuiSmokeContext | undefined {
  if (argv[1] !== GUI_SMOKE_ARGUMENT) return undefined;

  const requestedRoot = environment[GUI_SMOKE_ROOT_ENV];
  const nonce = environment[GUI_SMOKE_NONCE_ENV];
  if (
    !requestedRoot ||
    !isAbsolute(requestedRoot) ||
    !nonce ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      nonce,
    )
  ) {
    throw new Error("Invalid GUI smoke-test environment.");
  }

  const metadata = lstatSync(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("GUI smoke root must be a regular directory.");
  }
  const realTemporaryDirectory = realpathSync(temporaryDirectory);
  const realRoot = realpathSync(requestedRoot);
  if (!isStrictDescendant(realTemporaryDirectory, realRoot)) {
    throw new Error("GUI smoke root must be inside the OS temporary directory.");
  }

  const userDataPath = join(realRoot, "electron-user-data");
  const codexConfigPath = join(realRoot, "codex", "config.toml");
  const resultPath = join(realRoot, "renderer-ready.json");
  for (const candidate of [userDataPath, dirname(codexConfigPath), resultPath]) {
    if (existsSync(candidate)) {
      throw new Error("GUI smoke output already exists.");
    }
  }
  mkdirSync(userDataPath, { recursive: false });
  mkdirSync(dirname(codexConfigPath), { recursive: false });

  return {
    rootPath: realRoot,
    userDataPath,
    codexConfigPath,
    resultPath,
    nonce,
  };
}

export function writeGuiSmokeSuccess(
  context: GuiSmokeContext,
  isPackaged: boolean,
): void {
  const payload = {
    status: "renderer-loaded",
    nonce: context.nonce,
    isPackaged,
  };
  writeFileSync(context.resultPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}
