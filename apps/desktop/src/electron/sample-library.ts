import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  OWNCONTEXT_SAMPLE_LIBRARY_COLLECTION,
  OWNCONTEXT_SAMPLE_LIBRARY_FILES,
  OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
  OWNCONTEXT_SAMPLE_LIBRARY_SOURCE_LABEL,
  OWNCONTEXT_SAMPLE_LIBRARY_SUGGESTED_QUERY,
  OWNCONTEXT_SAMPLE_LIBRARY_VERSION,
} from "@owncontext/core";

export const SAMPLE_LIBRARY_VERSION = OWNCONTEXT_SAMPLE_LIBRARY_VERSION;
export const SAMPLE_LIBRARY_SOURCE_LABEL =
  OWNCONTEXT_SAMPLE_LIBRARY_SOURCE_LABEL;
// The first desktop connection grants this collection. Keeping the built-in
// sample inside it lets a new user test both local search and MCP safely.
export const SAMPLE_LIBRARY_COLLECTION = OWNCONTEXT_SAMPLE_LIBRARY_COLLECTION;
export const SAMPLE_LIBRARY_SUGGESTED_QUERY =
  OWNCONTEXT_SAMPLE_LIBRARY_SUGGESTED_QUERY;
export const SAMPLE_LIBRARY_PROVENANCE_ROOT =
  OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT;

const SAMPLE_CONTAINER_NAME = "sample-library";
const SAMPLE_VERSION_DIRECTORY_NAME = `v${SAMPLE_LIBRARY_VERSION}`;
const MAX_SAMPLE_FILES = 3;
const MAX_SAMPLE_FILE_BYTES = 16 * 1024;
const MAX_SAMPLE_TOTAL_BYTES = 32 * 1024;

interface ExactSampleFile {
  readonly name: string;
  readonly content: string;
}

const SAMPLE_FILES =
  OWNCONTEXT_SAMPLE_LIBRARY_FILES satisfies readonly ExactSampleFile[];

export interface SampleLibraryDescriptor {
  readonly version: typeof SAMPLE_LIBRARY_VERSION;
  readonly directoryPath: string;
  readonly sourceLabel: typeof SAMPLE_LIBRARY_SOURCE_LABEL;
  readonly collection: typeof SAMPLE_LIBRARY_COLLECTION;
  readonly suggestedQuery: typeof SAMPLE_LIBRARY_SUGGESTED_QUERY;
  readonly provenanceRootUri: typeof SAMPLE_LIBRARY_PROVENANCE_ROOT;
}

/**
 * Materializes the exact built-in sample beneath a trusted Electron userData
 * directory. Existing content is accepted only when its complete inventory and
 * bytes match this version; otherwise it is left untouched and the call fails.
 */
export async function materializeSampleLibrary(
  trustedUserDataRoot: string,
): Promise<SampleLibraryDescriptor> {
  assertBoundedDefinition();
  const userDataRoot = await requireTrustedRoot(trustedUserDataRoot);
  const sampleContainer = join(userDataRoot, SAMPLE_CONTAINER_NAME);
  assertStrictDescendant(userDataRoot, sampleContainer);
  const realSampleContainer = await ensureRegularDirectory(
    sampleContainer,
    userDataRoot,
  );
  const directoryPath = join(
    realSampleContainer,
    SAMPLE_VERSION_DIRECTORY_NAME,
  );
  assertStrictDescendant(realSampleContainer, directoryPath);

  if (await pathExists(directoryPath)) {
    await verifyExactSampleDirectory(directoryPath, realSampleContainer);
    return descriptor(directoryPath);
  }

  const temporaryDirectory = await mkdtemp(
    join(realSampleContainer, `.${SAMPLE_VERSION_DIRECTORY_NAME}-creating-`),
  );
  assertStrictDescendant(realSampleContainer, temporaryDirectory);
  await requireRegularDirectory(temporaryDirectory, realSampleContainer);

  try {
    for (const file of SAMPLE_FILES) {
      await writeExactFile(temporaryDirectory, file);
    }

    try {
      await rename(temporaryDirectory, directoryPath);
    } catch (error) {
      if (!(await pathExists(directoryPath))) throw error;
      await cleanupKnownTemporaryDirectory(temporaryDirectory);
      await verifyExactSampleDirectory(directoryPath, realSampleContainer);
      return descriptor(directoryPath);
    }
  } catch (error) {
    await cleanupKnownTemporaryDirectory(temporaryDirectory).catch(() => undefined);
    throw error;
  }

  await verifyExactSampleDirectory(directoryPath, realSampleContainer);
  return descriptor(directoryPath);
}

function descriptor(directoryPath: string): SampleLibraryDescriptor {
  return {
    version: SAMPLE_LIBRARY_VERSION,
    directoryPath,
    sourceLabel: SAMPLE_LIBRARY_SOURCE_LABEL,
    collection: SAMPLE_LIBRARY_COLLECTION,
    suggestedQuery: SAMPLE_LIBRARY_SUGGESTED_QUERY,
    provenanceRootUri: SAMPLE_LIBRARY_PROVENANCE_ROOT,
  };
}

function assertBoundedDefinition(): void {
  const files: readonly ExactSampleFile[] = SAMPLE_FILES;
  if (files.length === 0 || files.length > MAX_SAMPLE_FILES) {
    throw new Error("The built-in sample file inventory is outside its bound.");
  }

  let totalBytes = 0;
  const names = new Set<string>();
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (
      file.name.length === 0 ||
      file.name === "." ||
      file.name === ".." ||
      file.name.includes("/") ||
      file.name.includes("\\") ||
      names.has(file.name) ||
      bytes === 0 ||
      bytes > MAX_SAMPLE_FILE_BYTES
    ) {
      throw new Error("The built-in sample contains an invalid file definition.");
    }
    names.add(file.name);
    totalBytes += bytes;
  }

  if (totalBytes > MAX_SAMPLE_TOTAL_BYTES) {
    throw new Error("The built-in sample exceeds its total byte bound.");
  }
}

async function requireTrustedRoot(candidate: string): Promise<string> {
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    candidate.includes("\0") ||
    !isAbsolute(candidate)
  ) {
    throw new Error("Sample library userData root must be an absolute path.");
  }

  const requested = resolve(candidate);
  const metadata = await lstat(requested).catch(() => undefined);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Sample library userData root must be a regular directory.");
  }

  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) {
    throw new Error("Sample library userData root must not traverse a link.");
  }
  return canonical;
}

async function ensureRegularDirectory(
  candidate: string,
  trustedParent: string,
): Promise<string> {
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  return requireRegularDirectory(candidate, trustedParent);
}

async function requireRegularDirectory(
  candidate: string,
  trustedParent: string,
): Promise<string> {
  assertStrictDescendant(trustedParent, candidate);
  const metadata = await lstat(candidate).catch(() => undefined);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Sample library path is not a regular directory.");
  }

  const canonical = await realpath(candidate);
  if (!samePath(candidate, canonical)) {
    throw new Error("Sample library path must not traverse a link or junction.");
  }
  assertStrictDescendant(trustedParent, canonical);
  return canonical;
}

async function verifyExactSampleDirectory(
  directoryPath: string,
  trustedParent: string,
): Promise<void> {
  const canonicalDirectory = await requireRegularDirectory(
    directoryPath,
    trustedParent,
  );
  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  const expectedNames = SAMPLE_FILES.map((file) => file.name).sort();
  const actualNames = entries.map((entry) => entry.name).sort();

  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "Sample library path already contains content OhMyContext does not own.",
    );
  }

  for (const file of SAMPLE_FILES) {
    const filePath = join(canonicalDirectory, file.name);
    assertStrictDescendant(canonicalDirectory, filePath);
    const metadata = await lstat(filePath);
    const expectedBytes = Buffer.from(file.content, "utf8");
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== expectedBytes.byteLength
    ) {
      throw new Error(
      "Sample library path already contains content OhMyContext does not own.",
      );
    }

    const actualBytes = await readFile(filePath);
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(
      "Sample library path already contains content OhMyContext does not own.",
      );
    }
  }
}

async function writeExactFile(
  directoryPath: string,
  file: ExactSampleFile,
): Promise<void> {
  const filePath = join(directoryPath, file.name);
  assertStrictDescendant(directoryPath, filePath);
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(file.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupKnownTemporaryDirectory(
  directoryPath: string,
): Promise<void> {
  for (const file of SAMPLE_FILES) {
    await unlink(join(directoryPath, file.name)).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
  await rmdir(directoryPath).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  });
}

function assertStrictDescendant(parent: string, candidate: string): void {
  const difference = relative(
    canonicalComparablePath(parent),
    canonicalParentComparablePath(candidate),
  );
  if (
    difference.length === 0 ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("Sample library path escapes its trusted userData root.");
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = canonicalComparablePath(left);
  const normalizedRight = canonicalComparablePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function canonicalComparablePath(value: string): string {
  const normalized = resolve(value);
  try {
    return resolve(realpathSync.native(normalized));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return join(canonicalComparablePath(dirname(normalized)), basename(normalized));
  }
}

function canonicalParentComparablePath(value: string): string {
  const normalized = resolve(value);
  return join(
    canonicalComparablePath(dirname(normalized)),
    basename(normalized),
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
