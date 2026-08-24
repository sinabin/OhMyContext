import asar from "@electron/asar";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComplianceError,
  generateCompliance,
  verifyCompliance,
} from "../scripts/release-compliance.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function artifactFixture(): Promise<string> {
  const artifact = await mkdtemp(join(tmpdir(), "owncontext-compliance-"));
  temporaryPaths.push(artifact);
  await mkdir(join(artifact, "resources", "app"), { recursive: true });
  await writeFile(join(artifact, "OwnContext.exe"), "fixture executable", "utf8");
  await writeFile(
    join(artifact, "resources", "app", "main.js"),
    "console.log('fixture');\n",
    "utf8",
  );
  await copyFile(
    join(projectRoot, "node_modules", "electron", "dist", "LICENSE"),
    join(artifact, "LICENSE.electron.txt"),
  );
  await copyFile(
    join(projectRoot, "node_modules", "electron", "dist", "LICENSES.chromium.html"),
    join(artifact, "LICENSES.chromium.html"),
  );
  await copyFile(
    join(projectRoot, "node_modules", "electron", "dist", "ffmpeg.dll"),
    join(artifact, "ffmpeg.dll"),
  );
  return artifact;
}

async function packFixtureApplication(artifact: string): Promise<string> {
  const application = join(artifact, "resources", "app");
  const archive = join(artifact, "resources", "app.asar");
  const output = await asar.createPackage(application, archive);
  await finished(output);
  await rm(application, { recursive: true });
  return archive;
}

describe("release compliance artifact evidence", () => {
  it("generates and verifies notices, SPDX SBOM, and checksums from an unpacked artifact", async () => {
    const artifact = await artifactFixture();
    const generated = await generateCompliance({
      artifactPath: artifact,
      projectRoot,
      draft: true,
    });
    expect(generated.draft).toBe(true);
    expect(generated.componentCount).toBeGreaterThan(50);

    const notices = await readFile(join(artifact, "compliance", "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toContain("DRAFT — NOT FOR PUBLIC RELEASE");
    expect(notices).toContain("electron@43.4.1");
    expect(notices).toContain("react@19.2.8");
    expect(notices).not.toContain("lightningcss@1.33.0");
    expect(notices).not.toContain("@electron/asar@3.4.1");

    const sbom = JSON.parse(
      await readFile(join(artifact, "compliance", "SBOM.spdx.json"), "utf8"),
    ) as {
      spdxVersion: string;
      packages: Array<{
        name: string;
        licenseConcluded: string;
        licenseDeclared: string;
        externalRefs?: Array<{ referenceLocator: string }>;
      }>;
    };
    expect(sbom.spdxVersion).toBe("SPDX-2.3");
    expect(sbom.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ohmycontext", licenseDeclared: "NOASSERTION" }),
      expect.objectContaining({ name: "electron", licenseDeclared: "MIT" }),
      expect.objectContaining({
        name: "electron-bundled-chromium-components",
        licenseDeclared: "NOASSERTION",
      }),
      expect.objectContaining({
        name: "electron-bundled-ffmpeg",
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "LGPL-2.1-or-later",
      }),
    ]));
    expect(
      sbom.packages.find((item) => item.name === "@modelcontextprotocol/sdk")?.externalRefs,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        referenceLocator: "pkg:npm/%40modelcontextprotocol/sdk@1.30.0",
      }),
    ]));
    expect(sbom.packages.some((item) => item.name === "lightningcss")).toBe(false);

    const checksums = await readFile(join(artifact, "compliance", "SHA256SUMS"), "utf8");
    expect(checksums).toContain("LICENSE.electron.txt");
    expect(checksums).toContain("LICENSES.chromium.html");
    expect(checksums).toContain("compliance/SBOM.spdx.json");
    await expect(verifyCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .resolves.toMatchObject({ draft: true });
  });

  it("blocks non-draft generation while the OwnContext license is unresolved", async () => {
    const artifact = await artifactFixture();
    await expect(generateCompliance({ artifactPath: artifact, projectRoot })).rejects.toMatchObject({
      code: "PROJECT_LICENSE_UNRESOLVED",
    });
  });

  it("rejects artifacts that do not preserve exact Electron license evidence", async () => {
    const artifact = await artifactFixture();
    await writeFile(join(artifact, "LICENSES.chromium.html"), "truncated", "utf8");
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "ELECTRON_LICENSE_NOT_PRESERVED" });
  });

  it("rejects an FFmpeg binary that differs from the locked Electron distribution", async () => {
    const artifact = await artifactFixture();
    await writeFile(join(artifact, "ffmpeg.dll"), "different binary", "utf8");
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "ELECTRON_FFMPEG_VARIANT_UNRESOLVED" });
  });

  it("rejects an installed dev-only package inside the artifact", async () => {
    const artifact = await artifactFixture();
    const packageRoot = join(artifact, "resources", "app", "node_modules", "lightningcss");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "lightningcss", version: "1.33.0" }),
      "utf8",
    );
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "DEV_DEPENDENCY_IN_ARTIFACT" });
  });

  it("audits ASAR contents while checksumming the actual archive", async () => {
    const artifact = await artifactFixture();
    await packFixtureApplication(artifact);
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .resolves.toMatchObject({ draft: true });
    const checksums = await readFile(join(artifact, "compliance", "SHA256SUMS"), "utf8");
    expect(checksums).toContain("resources/app.asar");
  });

  it("rejects a dev-only package nested inside an ASAR", async () => {
    const artifact = await artifactFixture();
    const packageRoot = join(
      artifact,
      "resources",
      "app",
      "node_modules",
      "lightningcss",
    );
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "lightningcss", version: "1.33.0" }),
      "utf8",
    );
    await packFixtureApplication(artifact);
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "DEV_DEPENDENCY_IN_ARTIFACT" });
  });

  it("rejects malformed ASAR payloads that cannot be audited", async () => {
    const artifact = await artifactFixture();
    await rm(join(artifact, "resources", "app"), { recursive: true });
    await writeFile(join(artifact, "resources", "app.asar"), "opaque archive", "utf8");
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "ASAR_HEADER_UNSAFE" });
  });

  it("rejects a compliance output path that escapes through a junction", async () => {
    const artifact = await artifactFixture();
    const outside = await mkdtemp(join(tmpdir(), "owncontext-compliance-outside-"));
    temporaryPaths.push(outside);
    await symlink(outside, join(artifact, "compliance"), "junction");
    await expect(generateCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "COMPLIANCE_OUTPUT_UNSAFE" });
  });

  it("detects changed and unrecorded files after generation", async () => {
    const artifact = await artifactFixture();
    await generateCompliance({ artifactPath: artifact, projectRoot, draft: true });
    await writeFile(join(artifact, "resources", "app", "main.js"), "tampered\n", "utf8");
    await expect(verifyCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof ComplianceError &&
        ["SBOM_FILE_MISMATCH", "CHECKSUM_MISMATCH"].includes(error.code)
      );
  });

  it("rejects semantic SBOM changes even if the checksum manifest is refreshed", async () => {
    const artifact = await artifactFixture();
    await generateCompliance({ artifactPath: artifact, projectRoot, draft: true });
    const sbomPath = join(artifact, "compliance", "SBOM.spdx.json");
    const checksumPath = join(artifact, "compliance", "SHA256SUMS");
    const sbom = JSON.parse(await readFile(sbomPath, "utf8")) as {
      packages: Array<{ name: string; licenseConcluded: string }>;
    };
    const electron = sbom.packages.find((item) => item.name === "electron");
    if (!electron) throw new Error("fixture SBOM has no Electron package");
    electron.licenseConcluded = "GPL-3.0-only";
    await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
    const sbomHash = createHash("sha256").update(await readFile(sbomPath)).digest("hex");
    const checksums = await readFile(checksumPath, "utf8");
    await writeFile(
      checksumPath,
      checksums.replace(
        /^[0-9a-f]{64}  compliance\/SBOM\.spdx\.json$/mu,
        `${sbomHash}  compliance/SBOM.spdx.json`,
      ),
      "utf8",
    );
    await expect(verifyCompliance({ artifactPath: artifact, projectRoot, draft: true }))
      .rejects.toMatchObject({ code: "SBOM_CONTENT_MISMATCH" });
  });
});
