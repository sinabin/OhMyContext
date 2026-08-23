import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDirectory = resolve(fileURLToPath(import.meta.url), "..", "..");
const forgeConfigPath = resolve(desktopDirectory, "forge.config.mjs");
const templatePath = resolve(
  desktopDirectory,
  "packaging",
  "squirrel.nuspectemplate",
);

describe("repository-owned Squirrel NuSpec template", () => {
  it("configures the Squirrel maker with the absolute owned template path", async () => {
    const configModule = (await import(pathToFileURL(forgeConfigPath).href)) as {
      default: {
        makers?: Array<{
          name?: string;
          config?: Record<string, unknown>;
        }>;
      };
    };
    const squirrelMaker = configModule.default.makers?.find(
      (maker) => maker.name === "@electron-forge/maker-squirrel",
    );
    const configuredPath = squirrelMaker?.config?.nuspecTemplate;

    expect(configuredPath).toBe(templatePath);
    expect(typeof configuredPath).toBe("string");
    expect(isAbsolute(configuredPath as string)).toBe(true);
  });

  it("contains no install-time icon URL while retaining the NuSpec namespace", async () => {
    const template = await readFile(templatePath, "utf8");

    expect(template).not.toMatch(/<\/?iconUrl\b/iu);
    expect(template.match(/https?:\/\/[^"'\s<>]+/giu)).toEqual([
      "http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd",
    ]);
  });

  it("retains the complete default payload and additionalFiles loop", async () => {
    const template = await readFile(templatePath, "utf8");
    const requiredPayload = [
      '<file src="locales\\**" target="lib\\net45\\locales" />',
      '<file src="resources\\**" target="lib\\net45\\resources" />',
      '<file src="*.bin" target="lib\\net45" />',
      '<file src="*.dll" target="lib\\net45" />',
      '<file src="*.pak" target="lib\\net45" />',
      '<file src="*.exe.config" target="lib\\net45" />',
      '<file src="*.exe.sig" target="lib\\net45" />',
      '<file src="icudtl.dat" target="lib\\net45\\icudtl.dat" />',
      '<file src="Squirrel.exe" target="lib\\net45\\squirrel.exe" />',
      '<file src="LICENSE" target="lib\\net45\\LICENSE" />',
      '<file src="<%- exe %>" target="lib\\net45\\<%- exe %>" />',
    ];

    for (const payloadEntry of requiredPayload) {
      expect(template).toContain(payloadEntry);
    }
    expect(template).toContain("<% additionalFiles.forEach(function(f) { %>");
    expect(template).toContain(
      '<file src="<%- f.src %>" target="<%- f.target %>" />',
    );
    expect(template).toContain("<% }); %>");
  });
});
