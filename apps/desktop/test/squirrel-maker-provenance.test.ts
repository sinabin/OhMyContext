import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { NtExecutable } from "pe-library";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSquirrelReleaseRecord,
  verifyDeflateEntryFullyConsumed,
  verifyInvariantPeOrigin,
  verifyPackageTreeInventory,
  verifyPinnedNugetProductMetadata,
  verifyPinnedSquirrelMakerInputs,
  verifySetupArchiveInventory,
  verifyStrictSetupZipContainer,
  writeSquirrelMakerEvidenceAtomically,
  type PackageTreeEntry,
  type SetupArchiveInventoryEntry,
} from "../scripts/squirrel-maker-provenance.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(testDirectory, "..");
const projectRoot = resolve(desktopDirectory, "..", "..");
const electronWinstallerDirectory = resolve(projectRoot, "node_modules", "electron-winstaller");
const manifestPath = resolve(desktopDirectory, "packaging", "squirrel-maker-inputs.json");
const setupPath = resolve(electronWinstallerDirectory, "vendor", "Setup.exe");
const fullPackageName = "OwnContextDeveloperPreview-0.0.0-full.nupkg";
const temporaryRoots: string[] = [];
const currentContentTypesXml = [
  "\ufeff<?xml version=\"1.0\" encoding=\"utf-8\"?>",
  "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
  "  <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\" />",
  "  <Default Extension=\"nuspec\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"pak\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"asar\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"txt\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"json\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"js\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"node\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"mjs\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"bin\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"dll\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"dat\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"exe\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"html\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"psmdcp\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\" />",
  "  <Override PartName=\"/lib/net45/resources/encrypted-sqlite-runtime/LICENSE\" ContentType=\"application/octet\" />",
  "  <Override PartName=\"/lib/net45/LICENSE\" ContentType=\"application/octet\" />",
  "  <Override PartName=\"/lib/net45/version\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"diff\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"bsdiff\" ContentType=\"application/octet\" />",
  "  <Default Extension=\"shasum\" ContentType=\"text/plain\" />",
  "</Types>",
].join("\r\n");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("Squirrel maker provenance", () => {
  it("pins the exact installed electron-winstaller maker inputs", async () => {
    const evidence = await verifyPinnedSquirrelMakerInputs({
      manifestPath,
      electronWinstallerDirectory,
    });

    expect(evidence.package).toEqual({
      name: "electron-winstaller",
      version: "5.4.4",
      license: "MIT",
    });
    expect(evidence.packageTree).toEqual({
      fileCount: 96,
      totalBytes: 32_192_898,
      sha256: "cdc02edf52fcb51c9a1072f0e57a97bddae9bd1241d49cd90e979c77d338a504",
      excludedMutableFiles: [
        "vendor/Squirrel-Releasify.log",
        "vendor/Squirrel-Unset.log",
      ],
    });
    expect(evidence.files.map((file) => file.role)).toEqual([
      "packageMetadata",
      "packageLicense",
      "setupBootstrap",
      "squirrelExecutable",
      "executionStub",
      "installSpinner",
    ]);
  });

  it("pins the encrypted-runtime NuGet content types as exact bytes", () => {
    const current = Buffer.from(currentContentTypesXml, "utf8");
    expect(current).toHaveLength(1_622);
    expect(createHash("sha256").update(current).digest("hex"))
      .toBe("5f2b461b10b1ad19ebb1679fbded61a87a239eed2523390054138df0832e5c4d");
    expect(verifyPinnedNugetProductMetadata("[Content_Types].xml", current)).toEqual({
      name: "[Content_Types].xml",
      length: 1_622,
      sha256: "5f2b461b10b1ad19ebb1679fbded61a87a239eed2523390054138df0832e5c4d",
      transform: "pinned-bytes",
    });

    const previous = Buffer.from(currentContentTypesXml
      .replace("  <Default Extension=\"js\" ContentType=\"application/octet\" />\r\n", "")
      .replace("  <Default Extension=\"node\" ContentType=\"application/octet\" />\r\n", "")
      .replace(
        "  <Override PartName=\"/lib/net45/resources/encrypted-sqlite-runtime/LICENSE\" ContentType=\"application/octet\" />\r\n",
        "",
      ), "utf8");
    expect(previous).toHaveLength(1_383);
    expect(createHash("sha256").update(previous).digest("hex"))
      .toBe("d93df825279ed82e3896bb2ec67c503b7febe066e2821e22806d9e839222fbd9");
    expect(() => verifyPinnedNugetProductMetadata("[Content_Types].xml", previous))
      .toThrow(/differs from the pinned product transform/u);

    const mutated = Buffer.from(current);
    const mutationOffset = mutated.indexOf(Buffer.from("Extension=\"node\"", "utf8"));
    expect(mutationOffset).toBeGreaterThan(-1);
    mutated[mutationOffset] = (mutated[mutationOffset] ?? 0) ^ 1;
    expect(() => verifyPinnedNugetProductMetadata("[Content_Types].xml", mutated))
      .toThrow(/differs from the pinned product transform/u);
  });

  it("fails closed when a pinned input hash is altered", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-maker-manifest-"));
    temporaryRoots.push(root);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[2].sha256 = "0".repeat(64);
    const changedManifest = resolve(root, "squirrel-maker-inputs.json");
    await writeFile(changedManifest, `${JSON.stringify(manifest)}\n`, "utf8");

    await expect(verifyPinnedSquirrelMakerInputs({
      manifestPath: changedManifest,
      electronWinstallerDirectory,
    })).rejects.toThrow(/differs from the pinned bytes/u);
  });

  it("accepts the approved Setup PE and rejects invariant code changes and overlays", async () => {
    const approved = await readFile(setupPath);
    const result = verifyInvariantPeOrigin(approved, approved, "Setup fixture");
    expect(result.invariantSections.map((section) => section.name)).toEqual([
      ".text",
      ".rdata",
      ".data",
      ".reloc",
    ]);

    const changed = Buffer.from(approved);
    const executable = NtExecutable.from(changed);
    const text = executable.getAllSections().find((section) => section.info.name === ".text");
    if (!text) throw new Error("Setup fixture has no .text section.");
    const textOffset = text.info.pointerToRawData;
    changed[textOffset] = (changed[textOffset] ?? 0) ^ 1;
    expect(() => verifyInvariantPeOrigin(changed, approved, "Changed Setup fixture"))
      .toThrow(/changed invariant PE section \.text/u);

    expect(() => verifyInvariantPeOrigin(
      Buffer.concat([approved, Buffer.from([1])]),
      approved,
      "Overlay Setup fixture",
    )).toThrow(/unexpected PE overlay/u);
  });

  it("rejects non-derived PE headers, section metadata, and resource padding", async () => {
    const approved = await readFile(setupPath);
    const peOffset = approved.readUInt32LE(0x3c);
    const optionalHeaderOffset = peOffset + 24;
    const sectionTableOffset = optionalHeaderOffset + approved.readUInt16LE(peOffset + 20);
    const mutations = [
      ["COFF timestamp", peOffset + 8],
      ["image base", optionalHeaderOffset + 28],
      ["DLL characteristics", optionalHeaderOffset + 70],
      ["stack reserve", optionalHeaderOffset + 72],
      ["import directory RVA", optionalHeaderOffset + 96 + 8],
      ["resource section characteristics", sectionTableOffset + 3 * 40 + 36],
      ["DOS stub", 0x40],
    ] as const;
    for (const [name, offset] of mutations) {
      const changed = Buffer.from(approved);
      changed[offset] = (changed[offset] ?? 0) ^ 1;
      expect(
        () => verifyInvariantPeOrigin(changed, approved, `Changed ${name}`),
        name,
      ).toThrow();
    }

    const resourcePadding = Buffer.from(approved);
    const executable = NtExecutable.from(resourcePadding);
    const resource = executable.getAllSections().find((section) => section.info.name === ".rsrc");
    if (!resource) throw new Error("Setup fixture has no .rsrc section.");
    const lastPaddingByte = resource.info.pointerToRawData + resource.info.sizeOfRawData - 1;
    resourcePadding[lastPaddingByte] = (resourcePadding[lastPaddingByte] ?? 0) ^ 1;
    expect(() => verifyInvariantPeOrigin(resourcePadding, approved, "Changed resource padding"))
      .toThrow(/resource padding/u);
  });

  it("hashes an exact case-safe package file tree and rejects every inventory change", () => {
    const entries: PackageTreeEntry[] = [
      treeEntry("lib/index.js", "maker"),
      treeEntry("vendor/nuget.exe", "runner"),
    ];
    const indexEntry = entries[0];
    const nugetEntry = entries[1];
    if (!indexEntry || !nugetEntry) throw new Error("Tree fixture is incomplete.");
    const expected = treeEvidence(entries);
    expect(verifyPackageTreeInventory(entries, expected)).toEqual(expected);
    expect(() => verifyPackageTreeInventory(entries.slice(0, 1), expected))
      .toThrow(/file count/u);
    expect(() => verifyPackageTreeInventory(
      [...entries, treeEntry("extra.txt", "extra")],
      { ...expected, fileCount: 3 },
    )).toThrow(/differs from the pinned tree/u);
    expect(() => verifyPackageTreeInventory(
      [{ ...indexEntry, sha256: "0".repeat(64) }, nugetEntry],
      expected,
    )).toThrow(/differs from the pinned tree/u);
    expect(() => verifyPackageTreeInventory(
      [indexEntry, { ...nugetEntry, path: "LIB/INDEX.JS" }],
      expected,
    )).toThrow(/case-folded duplicate/u);
  });

  it("creates evidence atomically, is idempotent, and refuses conflicts or links", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-maker-evidence-"));
    temporaryRoots.push(root);
    const evidenceDirectory = resolve(root, "evidence");
    const evidencePath = resolve(evidenceDirectory, "SQUIRREL-MAKER-PROVENANCE.json");
    const evidence = { schemaVersion: 2, status: "test" };
    const outsideDirectory = `${root}-outside`;
    temporaryRoots.push(outsideDirectory);
    await expect(writeSquirrelMakerEvidenceAtomically(
      resolve(outsideDirectory, "SQUIRREL-MAKER-PROVENANCE.json"),
      root,
      evidence,
    )).rejects.toThrow(/escapes its approved root/u);
    await expect(access(outsideDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    await writeSquirrelMakerEvidenceAtomically(evidencePath, root, evidence);
    await writeSquirrelMakerEvidenceAtomically(evidencePath, root, evidence);
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual(evidence);

    await writeFile(evidencePath, "conflict\n", "utf8");
    await expect(writeSquirrelMakerEvidenceAtomically(evidencePath, root, evidence))
      .rejects.toThrow(/differs from the verified result/u);

    await rm(evidencePath);
    const linkTarget = resolve(root, "link-target.json");
    await writeFile(linkTarget, "target\n", "utf8");
    try {
      await symlink(linkTarget, evidencePath, "file");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EPERM") {
        throw error;
      }
      return;
    }
    await expect(writeSquirrelMakerEvidenceAtomically(evidencePath, root, evidence))
      .rejects.toThrow(/not a regular file/u);
    expect(await readFile(linkTarget, "utf8")).toBe("target\n");
  });

  it("parses exactly one complete RELEASES record", () => {
    const record = parseSquirrelReleaseRecord(
      `${"A".repeat(40)} ${fullPackageName} 12345`,
      fullPackageName,
    );
    expect(record).toEqual({
      sha1: "a".repeat(40),
      fileName: fullPackageName,
      size: 12345,
    });

    expect(() => parseSquirrelReleaseRecord(
      `${"A".repeat(40)} ${fullPackageName} 12345\n${"B".repeat(40)} other-full.nupkg 9`,
      fullPackageName,
    )).toThrow(/exactly one complete record/u);
  });

  it("requires the exact safe four-entry Setup ZIP inventory", () => {
    const expected = ["background.gif", fullPackageName, "RELEASES", "Update.exe"];
    const entries = expected.map(zipEntry);
    expect(verifySetupArchiveInventory(entries, expected)).toEqual(expected);

    expect(() => verifySetupArchiveInventory(
      entries.map((entry) => entry.name === "Update.exe"
        ? { ...entry, name: "update.exe" }
        : entry),
      expected,
    )).toThrow(/unexpected or unsafe/u);

    expect(() => verifySetupArchiveInventory(
      entries.map((entry) => entry.name === "RELEASES"
        ? { ...entry, name: "..\\RELEASES" }
        : entry),
      expected,
    )).toThrow(/unsafe relative path/u);
  });

  it("rejects Setup ZIP local/central differentials, extras, gaps, and trailing bytes", () => {
    const names = ["background.gif", fullPackageName, "RELEASES", "Update.exe"];
    const archive = makeStrictZip(names);
    const strict = verifyStrictSetupZipContainer(archive, names);
    expect(strict.entries.map((entry) => entry.name)).toEqual(names);

    const changedLocalName = Buffer.from(archive);
    changedLocalName[30] = (changedLocalName[30] ?? 0) ^ 1;
    expect(() => verifyStrictSetupZipContainer(changedLocalName, names)).toThrow();

    const changedLocalFlags = Buffer.from(archive);
    changedLocalFlags.writeUInt16LE(8, 6);
    expect(() => verifyStrictSetupZipContainer(changedLocalFlags, names))
      .toThrow(/local metadata/u);

    const changedCentralComment = Buffer.from(archive);
    changedCentralComment.writeUInt16LE(1, strict.centralOffset + 32);
    expect(() => verifyStrictSetupZipContainer(changedCentralComment, names))
      .toThrow(/central metadata/u);

    expect(() => verifyStrictSetupZipContainer(
      Buffer.concat([archive, Buffer.from([0])]),
      names,
    )).toThrow(/EOCD/u);
  });

  it("rejects bytes hidden after a valid embedded DEFLATE stream", async () => {
    const contents = Buffer.from("bounded deflate fixture", "utf8");
    const compressed = deflateRawSync(contents);
    const expected = {
      uncompressedLength: contents.length,
      crc32: fixtureCrc32(contents).toString(16).padStart(8, "0"),
    };
    await expect(verifyDeflateEntryFullyConsumed(compressed, expected)).resolves.toEqual({
      compressedLength: compressed.length,
      ...expected,
    });
    await expect(verifyDeflateEntryFullyConsumed(
      Buffer.concat([compressed, Buffer.from("hidden-tail", "ascii")]),
      expected,
    )).rejects.toThrow(/trailing input/u);
  });
});

function zipEntry(name: string): SetupArchiveInventoryEntry {
  return {
    name,
    length: 10,
    directory: false,
    compressionMethod: 8,
    generalPurposeBitFlag: 0,
  };
}

function treeEntry(path: string, contents: string): PackageTreeEntry {
  const bytes = Buffer.from(contents, "utf8");
  return {
    path,
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function treeEvidence(entries: PackageTreeEntry[]) {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256");
  for (const entry of sorted) {
    digest.update(`${entry.path}\t${entry.length}\t${entry.sha256}\n`, "utf8");
  }
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.length, 0),
    sha256: digest.digest("hex"),
    excludedMutableFiles: [
      "vendor/Squirrel-Releasify.log",
      "vendor/Squirrel-Unset.log",
    ],
  };
}

function makeStrictZip(names: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const contents = Buffer.from(`fixture:${name}`, "utf8");
    const compressed = deflateRawSync(contents);
    const crc32 = fixtureCrc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x6000, 10);
    local.writeUInt16LE(0x5d17, 12);
    local.writeUInt32LE(crc32, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x6000, 12);
    central.writeUInt16LE(0x5d17, 14);
    central.writeUInt32LE(crc32, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function fixtureCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
