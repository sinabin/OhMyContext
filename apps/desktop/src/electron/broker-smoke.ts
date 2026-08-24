import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const BROKER_SMOKE_ARGUMENT = "--owncontext-mcp-broker-smoke";
export const BROKER_SMOKE_ROOT_ENV = "OWNCONTEXT_BROKER_SMOKE_ROOT";
export const BROKER_SMOKE_NONCE_ENV = "OWNCONTEXT_BROKER_SMOKE_NONCE";

export interface BrokerSmokeContext {
  readonly rootPath: string;
  readonly userDataPath: string;
  readonly resultPath: string;
  readonly nonce: string;
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function prepareBrokerSmoke(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  temporaryDirectory = tmpdir(),
): BrokerSmokeContext | undefined {
  if (argv[1] !== BROKER_SMOKE_ARGUMENT) return undefined;
  const requestedRoot = environment[BROKER_SMOKE_ROOT_ENV];
  const nonce = environment[BROKER_SMOKE_NONCE_ENV];
  if (
    !requestedRoot || !isAbsolute(requestedRoot) ||
    !nonce || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(nonce)
  ) {
    throw new Error("Invalid MCP broker smoke-test environment.");
  }
  const temporaryRoot = realpathSync(temporaryDirectory);
  const root = realpathSync(requestedRoot);
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !strictDescendant(temporaryRoot, root)) {
    throw new Error("MCP broker smoke root must be a regular temporary directory.");
  }
  const userDataPath = join(root, "electron-user-data");
  const resultPath = join(root, "broker-ready.json");
  if (existsSync(userDataPath) || existsSync(resultPath)) {
    throw new Error("MCP broker smoke output already exists.");
  }
  mkdirSync(userDataPath, { recursive: false });
  return { rootPath: root, userDataPath, resultPath, nonce };
}

export function writeBrokerSmokeReady(
  context: BrokerSmokeContext,
  pipeName: string,
  collection: string,
  query: string,
): void {
  const resultDirectory = dirname(context.resultPath);
  if (resolve(resultDirectory) !== context.rootPath) {
    throw new Error("MCP broker smoke result path escaped its root.");
  }
  writeFileSync(
    context.resultPath,
    `${JSON.stringify({
      status: "encrypted-vault-broker-ready",
      nonce: context.nonce,
      pipeName,
      collection,
      query,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}
