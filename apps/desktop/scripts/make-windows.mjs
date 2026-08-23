import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORGE_BUILD_ID_ENV,
  resolveForgeBuildIdentifier,
} from "./forge-build-id.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptsDirectory, "..");
const projectRoot = resolve(desktopDirectory, "..", "..");
const forgeCli = resolve(
  projectRoot,
  "node_modules",
  "@electron-forge",
  "cli",
  "dist",
  "electron-forge.js",
);
const complianceCli = resolve(projectRoot, "scripts", "release-compliance.mjs");
const smokeScript = resolve(scriptsDirectory, "smoke-packaged.mjs");
const buildIdentifier = resolveForgeBuildIdentifier();
const buildDirectory = resolve(desktopDirectory, "out", buildIdentifier);
const packagedDirectory = resolve(
  buildDirectory,
  "OwnContext Developer Preview-win32-x64",
);
const complianceDirectory = resolve(
  packagedDirectory,
  "resources",
  "compliance",
);
const childEnvironment = {
  ...process.env,
  [FORGE_BUILD_ID_ENV]: buildIdentifier,
};
const packageOnly = process.argv[2] === "--package-only";

if (process.argv.length > (packageOnly ? 3 : 2)) {
  throw new Error("Unknown Windows packaging argument.");
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Windows maker requires a Windows x64 build host.");
}

async function requireMissingBuildDirectory() {
  try {
    await lstat(buildDirectory);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Refusing to reuse an existing Forge build directory: ${buildIdentifier}`,
  );
}

async function requirePackagedDirectory() {
  const metadata = await lstat(packagedDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Forge did not produce the expected regular package directory.");
  }
}

async function run(label, args) {
  process.stdout.write(`\n[OwnContext make] ${label}\n`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: desktopDirectory,
      env: childEnvironment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
        ),
      );
    });
  });
}

await requireMissingBuildDirectory();

await run("package Windows x64 application", [
  forgeCli,
  "package",
  "--platform",
  "win32",
  "--arch",
  "x64",
]);
await requirePackagedDirectory();

await run("generate draft compliance evidence", [
  complianceCli,
  "generate",
  "--artifact",
  packagedDirectory,
  "--output",
  complianceDirectory,
  "--project-root",
  projectRoot,
  "--draft",
]);

await run("verify draft compliance evidence", [
  complianceCli,
  "verify",
  "--artifact",
  packagedDirectory,
  "--output",
  complianceDirectory,
  "--project-root",
  projectRoot,
  "--draft",
]);

if (!packageOnly) {
  await run("make Squirrel.Windows artifacts from the verified package", [
    forgeCli,
    "make",
    "--skip-package",
    "--platform",
    "win32",
    "--arch",
    "x64",
  ]);
}

await run(
  packageOnly
    ? "smoke-test packaged runtime and compliance evidence"
    : "smoke-test packaged MCP, compliance evidence, and maker outputs",
  packageOnly ? [smokeScript] : [smokeScript, "--require-maker"],
);

process.stdout.write(
  `\nUnsigned developer ${packageOnly ? "package" : "artifacts"} created under ${buildDirectory}\n`,
);
