import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveForgeBuildIdentifier } from "./scripts/forge-build-id.mjs";

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const generatedRuntime = resolve(desktopDirectory, ".forge-runtime");
const previewNotice = resolve(
  desktopDirectory,
  "packaging",
  "UNSIGNED-DEVELOPER-PREVIEW.txt",
);
const buildIdentifier = resolveForgeBuildIdentifier();

const allowedApplicationFiles = new Set([
  "package.json",
  "dist",
  "dist/renderer",
  "dist-electron",
  "dist-electron/main.js",
  "dist-electron/preload.cjs",
]);

function normalizeRelativePath(candidate) {
  const normalizedCandidate = candidate.split(sep).join("/");
  const normalizedRoot = desktopDirectory.split(sep).join("/");
  if (
    normalizedCandidate.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
  ) {
    return normalizedCandidate.slice(normalizedRoot.length + 1);
  }
  return normalizedCandidate.replace(/^\/+/, "");
}

/** Keep the packaged ASAR deterministic and independent of npm workspace layout. */
function ignoreNonRuntimeFile(candidate) {
  const path = normalizeRelativePath(candidate);
  if (path === "") return false;
  if (allowedApplicationFiles.has(path)) return false;
  if (path.startsWith("dist/renderer/")) return false;
  return true;
}

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
const config = {
  // A unique directory avoids locked-DLL overwrite failures in synced folders.
  buildIdentifier,
  packagerConfig: {
    asar: true,
    executableName: "OwnContextDeveloperPreview",
    extraResource: [
      resolve(generatedRuntime, "mcp-server"),
      previewNotice,
    ],
    ignore: ignoreNonRuntimeFile,
    overwrite: true,
    prune: false,
    win32metadata: {
      CompanyName: "OwnContext project contributors",
      FileDescription: "OwnContext unsigned developer preview",
      InternalName: "OwnContextDeveloperPreview",
      OriginalFilename: "OwnContextDeveloperPreview.exe",
      ProductName: "OwnContext Developer Preview (Unsigned)",
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "OwnContextDeveloperPreview",
        authors: "OwnContext project contributors",
        description:
          "Unsigned developer preview for non-sensitive OwnContext evaluation data.",
        noMsi: true,
        setupExe: "OwnContext-Developer-Preview-Unsigned-Setup.exe",
      },
    },
  ],
  publishers: [],
};

export default config;
