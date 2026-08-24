import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveForgeBuildIdentifier } from "./scripts/forge-build-id.mjs";
import { resolveReleaseProfile } from "./scripts/release-profile.mjs";

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const generatedRuntime = resolve(desktopDirectory, ".forge-runtime");
const squirrelNuspecTemplate = resolve(
  desktopDirectory,
  "packaging",
  "squirrel.nuspectemplate",
);
const previewNotice = resolve(
  desktopDirectory,
  "packaging",
  "UNSIGNED-DEVELOPER-PREVIEW.txt",
);
const buildIdentifier = resolveForgeBuildIdentifier();
const releaseProfile = resolveReleaseProfile();

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
    executableName: releaseProfile.executableName,
    ...(releaseProfile.publicRelease
      ? { appVersion: releaseProfile.version, windowsSign: releaseProfile.signing }
      : {}),
    extraResource: [
      resolve(generatedRuntime, "mcp-server"),
      resolve(generatedRuntime, "encrypted-sqlite-runtime"),
      ...(releaseProfile.publicRelease ? [] : [previewNotice]),
    ],
    ignore: ignoreNonRuntimeFile,
    overwrite: true,
    prune: false,
    win32metadata: {
      CompanyName: releaseProfile.publicRelease
        ? "NextH and OhMyContext contributors"
        : "OhMyContext project contributors",
      FileDescription: releaseProfile.description,
      InternalName: releaseProfile.executableName,
      OriginalFilename: `${releaseProfile.executableName}.exe`,
      ProductName: releaseProfile.productName,
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: releaseProfile.squirrelName,
        authors: "OhMyContext project contributors",
        description: releaseProfile.description,
        ...(releaseProfile.publicRelease ? { windowsSign: releaseProfile.signing } : {}),
        nuspecTemplate: squirrelNuspecTemplate,
        // electron-winstaller's default NuSpec template omits these two
        // extensionless/HTML Electron payload files. Keep the installed image
        // byte-equivalent to the package that compliance inspected.
        additionalFiles: [
          {
            src: "LICENSES.chromium.html",
            target: "lib\\net45\\LICENSES.chromium.html",
          },
          { src: "version", target: "lib\\net45\\version" },
        ],
        noMsi: true,
        setupExe: releaseProfile.setupExe,
      },
    },
  ],
  publishers: [],
};

export default config;
