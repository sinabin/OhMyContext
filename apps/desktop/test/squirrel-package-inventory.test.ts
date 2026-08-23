import { describe, expect, it } from "vitest";
import {
  verifySquirrelPackageInventory,
  type NupkgInventoryEntry,
  type PayloadInventoryFile,
} from "../scripts/squirrel-package-inventory.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("Squirrel full-package inventory", () => {
  it("accepts an exact payload plus the explicit maker and NuGet layers", () => {
    const result = verifySquirrelPackageInventory(fixture());

    expect(result.payloadFileCount).toBe(3);
    expect(result.makerAddedFiles).toEqual([
      "lib/net45/squirrel.exe",
      "lib/net45/OwnContextDeveloperPreview_ExecutionStub.exe",
    ]);
    expect(result.metadataFiles).toHaveLength(4);
  });

  it("rejects a payload file omitted by the NuSpec template", () => {
    const input = fixture();
    input.nupkgEntries = input.nupkgEntries.filter(
      (entry) => entry.name !== "lib/net45/LICENSES.chromium.html",
    );

    expect(() => verifySquirrelPackageInventory(input)).toThrow(
      /missing verified payload file: LICENSES\.chromium\.html/u,
    );
  });

  it("rejects changed payload bytes", () => {
    const input = fixture();
    const entry = input.nupkgEntries.find(
      (candidate) => candidate.name === "lib/net45/resources/app.asar",
    );
    if (!entry) throw new Error("fixture entry is missing");
    entry.sha256 = C;

    expect(() => verifySquirrelPackageInventory(input)).toThrow(
      /changed verified payload bytes: resources\/app\.asar/u,
    );
  });

  it("rejects an unexpected file in the installed application layer", () => {
    const input = fixture();
    input.nupkgEntries.push(file("lib/net45/unreviewed.exe", 9, C));

    expect(() => verifySquirrelPackageInventory(input)).toThrow(
      /unexpected file: lib\/net45\/unreviewed\.exe/u,
    );
  });

  it("rejects unexpected package metadata and case-folded duplicates", () => {
    const unexpected = fixture();
    unexpected.nupkgEntries.push(file("unreviewed.xml", 9, C));
    expect(() => verifySquirrelPackageInventory(unexpected)).toThrow(
      /unexpected file: unreviewed\.xml/u,
    );

    const duplicate = fixture();
    duplicate.nupkgEntries.push(file("LIB/net45/version", 3, B));
    expect(() => verifySquirrelPackageInventory(duplicate)).toThrow(
      /case-folded duplicate/u,
    );
  });

  it("rejects backslash archive paths instead of normalizing them", () => {
    const input = fixture();
    const entry = input.nupkgEntries.find(
      (candidate) => candidate.name === "lib/net45/version",
    );
    if (!entry) throw new Error("fixture entry is missing");
    entry.name = "lib\\net45\\version";

    expect(() => verifySquirrelPackageInventory(input)).toThrow(
      /unsafe archive path/u,
    );
  });
});

function fixture(): {
  payloadFiles: PayloadInventoryFile[];
  nupkgEntries: NupkgInventoryEntry[];
  packageName: string;
  applicationExecutableName: string;
} {
  const payloadFiles = [
    payload("LICENSES.chromium.html", 10, A),
    payload("resources/app.asar", 20, B),
    payload("version", 3, C),
  ];
  const nupkgEntries = [
    directory("lib/"),
    directory("lib/net45/"),
    file("lib/net45/LICENSES.chromium.html", 10, A),
    directory("lib/net45/resources/"),
    file("lib/net45/resources/app.asar", 20, B),
    file("lib/net45/version", 3, C),
    file("lib/net45/squirrel.exe", 30, A),
    file("lib/net45/OwnContextDeveloperPreview_ExecutionStub.exe", 40, B),
    file("OwnContextDeveloperPreview.nuspec", 50, C),
    directory("package/"),
    directory("package/services/"),
    directory("package/services/metadata/"),
    directory("package/services/metadata/core-properties/"),
    file(
      "package/services/metadata/core-properties/0123456789abcdef0123456789abcdef.psmdcp",
      60,
      A,
    ),
    file("[Content_Types].xml", 70, B),
    directory("_rels/"),
    file("_rels/.rels", 80, C),
  ];
  return {
    payloadFiles,
    nupkgEntries,
    packageName: "OwnContextDeveloperPreview",
    applicationExecutableName: "OwnContextDeveloperPreview.exe",
  };
}

function payload(
  relativePath: string,
  length: number,
  sha256: string,
): PayloadInventoryFile {
  return { relativePath, length, sha256 };
}

function file(
  name: string,
  length: number,
  sha256: string,
): NupkgInventoryEntry {
  return { name, length, sha256, directory: false };
}

function directory(name: string): NupkgInventoryEntry {
  return { name, length: 0, sha256: A, directory: true };
}
