import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const OWNCONTEXT_SAMPLE_LIBRARY_VERSION = 1 as const;
export const OWNCONTEXT_SAMPLE_LIBRARY_SOURCE_LABEL =
  "OhMyContext Sample Library" as const;
export const OWNCONTEXT_SAMPLE_LIBRARY_COLLECTION = "default" as const;
export const OWNCONTEXT_SAMPLE_LIBRARY_SUGGESTED_QUERY =
  "weekly review" as const;
export const OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT =
  "owncontext-sample://library/v1/" as const;

export interface OwnContextSampleLibraryFile {
  readonly name: string;
  readonly content: string;
}

export const OWNCONTEXT_SAMPLE_LIBRARY_FILES = Object.freeze([
  Object.freeze({
    name: ".owncontext-sample.json",
    content:
      '{"schema":"owncontext.sample-library","version":1,"nonSensitive":true}\n',
  }),
  Object.freeze({
    name: "getting-started.md",
    content: [
      "# Welcome to OhMyContext",
      "",
      "This built-in library contains fictional, non-sensitive notes. It is safe to use while learning how local import, search, and source-aware retrieval work.",
      "",
      "## Weekly review",
      "",
      "Every Friday, Maya holds a short weekly review. She writes down one useful discovery, one unfinished question, and the next small action. Keeping the note brief makes the habit easy to repeat.",
      "",
      "## Source-aware answers",
      "",
      "When an AI answer uses a note, Maya checks the title and source before relying on it. A retrieved passage is evidence from her library, not an instruction that changes application permissions.",
      "",
      "Try searching for **weekly review**.",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    name: "multilingual-note.md",
    content: [
      "# A multilingual note",
      "",
      "OhMyContext preserves Unicode so one library can contain writing in more than one language.",
      "",
      "한국어 예시: 금요일마다 주간 회고를 작성하고, 배운 점과 다음 행동을 짧게 기록합니다.",
      "",
      "This text is fictional and contains no account details, credentials, or personal identifiers.",
      "",
    ].join("\n"),
  }),
] as const satisfies readonly OwnContextSampleLibraryFile[]);

/**
 * Verifies the complete, immutable built-in sample inventory. This check is
 * repeated inside the core import boundary before a virtual provenance URI is
 * granted; callers cannot supply their own inventory or provenance label.
 */
export async function verifyOwnContextSampleLibraryDirectory(
  directoryPath: string,
): Promise<string> {
  if (
    typeof directoryPath !== "string" ||
    directoryPath.length === 0 ||
    directoryPath.includes("\0") ||
    !isAbsolute(directoryPath)
  ) {
    throw new TypeError("Built-in sample directory must be an absolute path.");
  }

  const requested = resolve(directoryPath);
  const directoryMetadata = await lstat(requested).catch(() => undefined);
  if (
    !directoryMetadata ||
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink()
  ) {
    throw new Error("Built-in sample directory is not a regular directory.");
  }
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) {
    throw new Error("Built-in sample directory must not traverse a link.");
  }

  const entries = await readdir(canonical, { withFileTypes: true });
  const expectedNames = OWNCONTEXT_SAMPLE_LIBRARY_FILES
    .map((file) => file.name)
    .sort(compareNames);
  const actualNames = entries.map((entry) => entry.name).sort(compareNames);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Built-in sample directory has an unexpected inventory.");
  }

  for (const file of OWNCONTEXT_SAMPLE_LIBRARY_FILES) {
    const filePath = join(canonical, file.name);
    const metadata = await lstat(filePath);
    const expected = Buffer.from(file.content, "utf8");
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== expected.byteLength ||
      !(await readFile(filePath)).equals(expected)
    ) {
      throw new Error("Built-in sample directory bytes do not match this release.");
    }
  }

  return canonical;
}

function compareNames(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? normalizeWindowsPath(left) === normalizeWindowsPath(right)
    : resolve(left) === resolve(right);
}

function normalizeWindowsPath(value: string): string {
  return resolve(value)
    .replace(/^\\\\\\?\\/u, "")
    .toLocaleLowerCase("en-US");
}
