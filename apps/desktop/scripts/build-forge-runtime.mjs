import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptsDirectory, "..");
const repositoryDirectory = resolve(desktopDirectory, "..", "..");
const generatedDirectory = resolve(desktopDirectory, ".forge-runtime");
const mcpDirectory = resolve(generatedDirectory, "mcp-server");

function assertGeneratedDirectory(candidate) {
  const normalized = relative(desktopDirectory, candidate).split(sep).join("/");
  if (normalized !== ".forge-runtime") {
    throw new Error("Refusing to replace an unexpected generated directory.");
  }
}

assertGeneratedDirectory(generatedDirectory);
await rm(generatedDirectory, { recursive: true, force: true });
await mkdir(mcpDirectory, { recursive: true });

await build({
  entryPoints: [resolve(desktopDirectory, "src", "electron", "main.ts")],
  outfile: resolve(desktopDirectory, "dist-electron", "main.js"),
  bundle: true,
  external: ["electron"],
  format: "esm",
  legalComments: "none",
  minify: false,
  platform: "node",
  sourcemap: false,
  target: "node24",
});

await build({
  entryPoints: [resolve(desktopDirectory, "src", "electron", "preload.cts")],
  outfile: resolve(desktopDirectory, "dist-electron", "preload.cjs"),
  bundle: true,
  external: ["electron"],
  format: "cjs",
  legalComments: "none",
  minify: false,
  platform: "node",
  sourcemap: false,
  target: "node24",
});

const mcpEntry = resolve(
  repositoryDirectory,
  "apps",
  "mcp-server",
  "dist",
  "cli.js",
);
const mcpOutput = resolve(mcpDirectory, "cli.mjs");
await build({
  entryPoints: [mcpEntry],
  outfile: mcpOutput,
  bundle: true,
  format: "esm",
  legalComments: "none",
  minify: false,
  platform: "node",
  sourcemap: false,
  target: "node24",
});

const mcpBytes = await readFile(mcpOutput);
const manifest = {
  artifact: "OwnContext MCP runtime",
  classification: "unsigned-developer-preview",
  entry: "cli.mjs",
  sha256: createHash("sha256").update(mcpBytes).digest("hex"),
};
await writeFile(
  resolve(mcpDirectory, "runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
