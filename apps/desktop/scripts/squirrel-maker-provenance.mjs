import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInflateRaw } from "node:zlib";
import { NtExecutable, NtExecutableResource } from "pe-library";
import yauzl from "yauzl";

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_RECORD = /^([0-9A-F]{40}) ([A-Za-z0-9._-]+-full\.nupkg) ([1-9][0-9]*)(?:\r?\n)?$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_TREE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_TREE_FILES = 4_096;
const MAX_MAKER_CONTAINER_BYTES = 768 * 1024 * 1024;
const MAX_MAKER_EXECUTABLE_BYTES = 32 * 1024 * 1024;
const MAX_APPLICATION_EXECUTABLE_BYTES = 384 * 1024 * 1024;
const MAX_NUPKG_ENTRIES = 20_000;
const EXPECTED_INPUTS = new Map([
  ["packageMetadata", "package.json"],
  ["packageLicense", "LICENSE"],
  ["setupBootstrap", "vendor/Setup.exe"],
  ["squirrelExecutable", "vendor/Squirrel.exe"],
  ["executionStub", "vendor/StubExecutable.exe"],
  ["installSpinner", "resources/install-spinner.gif"],
]);
const EXCLUDED_MUTABLE_PACKAGE_OUTPUTS = [
  "vendor/Squirrel-Releasify.log",
  "vendor/Squirrel-Unset.log",
];
const INVARIANT_PE_SECTIONS = [".text", ".rdata", ".data", ".reloc"];
const EXPECTED_PE_SECTIONS = [".text", ".rdata", ".data", ".rsrc", ".reloc"];
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const SQUIRREL_RESOURCE_PADDING = Buffer.from("PADDINGXXPADDING", "ascii");
const CANONICAL_RESOURCE_BYTES = Uint8Array.from([
  0x4f, 0x57, 0x4e, 0x43, 0x4f, 0x4e, 0x54, 0x45, 0x58, 0x54,
]).buffer;
const EXPECTED_SETUP_VERSION_RESOURCE = {
  length: 1_076,
  sha256: "33afdb337220d75772ea1285e93219689a7cfcafe4b9abc9854373e6f051382f",
};
const NUGET_CORE_PROPERTIES =
  /^package\/services\/metadata\/core-properties\/[0-9a-f]{32}\.psmdcp$/u;
const PINNED_NUGET_METADATA = new Map([
  ["OwnContextDeveloperPreview.nuspec", {
    length: 738,
    sha256: "8b4241eb4680aa450cbddfafe2055b4e07351fdd79b6dd31dde89adfea625e5f",
  }],
  ["[Content_Types].xml", {
    length: 1_383,
    sha256: "d93df825279ed82e3896bb2ec67c503b7febe066e2821e22806d9e839222fbd9",
  }],
]);
const PINNED_NUGET_CORE_PROPERTIES = {
  length: 745,
  sha256: "09998bd5901df7bbcddae023bda8d82a6531eb0425a10db671a616fd8b6290f4",
};
const NORMALIZED_NUGET_RELATIONSHIPS =
  "\ufeff<?xml version=\"1.0\" encoding=\"utf-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Type=\"http://schemas.microsoft.com/packaging/2010/07/manifest\" Target=\"/OwnContextDeveloperPreview.nuspec\" Id=\"R<id>\" /><Relationship Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"/<core>\" Id=\"R<id>\" /></Relationships>";
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function folded(value) {
  return value.toLocaleLowerCase("en-US");
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function updateCrc32(state, bytes) {
  let current = state;
  for (const value of bytes) {
    current = CRC32_TABLE[(current ^ value) & 0xff] ^ (current >>> 8);
  }
  return current >>> 0;
}

function formatCrc32(state) {
  return ((state ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected schema.`);
  }
}

function requireSafeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    WINDOWS_DRIVE.test(value) ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${label} has an unsafe relative path: ${String(value)}`);
  }
  return value;
}

function requireInside(root, candidate, label) {
  const path = relative(root, candidate);
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    throw new Error(`${label} escapes its approved root.`);
  }
}

async function readRegularFile(path, label, maximumBytes) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} has an unsupported size.`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return bytes;
}

async function hashRegularFile(path, label, maximumBytes, algorithms) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} has an unsupported size.`);
  }
  const hashes = new Map(algorithms.map((algorithm) => [algorithm, createHash(algorithm)]));
  let length = 0;
  for await (const chunk of createReadStream(path)) {
    length += chunk.length;
    if (length > metadata.size) throw new Error(`${label} grew while it was being read.`);
    for (const hash of hashes.values()) hash.update(chunk);
  }
  if (length !== metadata.size) throw new Error(`${label} changed while it was being read.`);
  return {
    length,
    hashes: Object.fromEntries(
      [...hashes.entries()].map(([algorithm, hash]) => [algorithm, hash.digest("hex")]),
    ),
  };
}

export function verifyPackageTreeInventory(entries, expected) {
  const approved = requireObject(expected, "Squirrel maker package-tree evidence");
  requireExactKeys(
    approved,
    ["fileCount", "totalBytes", "sha256", "excludedMutableFiles"],
    "Squirrel maker package-tree evidence",
  );
  if (
    !Number.isSafeInteger(approved.fileCount) ||
    approved.fileCount <= 0 ||
    approved.fileCount > MAX_PACKAGE_TREE_FILES ||
    !Number.isSafeInteger(approved.totalBytes) ||
    approved.totalBytes <= 0 ||
    approved.totalBytes > MAX_PACKAGE_TREE_BYTES ||
    typeof approved.sha256 !== "string" ||
    !SHA256.test(approved.sha256) ||
    !Array.isArray(approved.excludedMutableFiles) ||
    approved.excludedMutableFiles.length !== EXCLUDED_MUTABLE_PACKAGE_OUTPUTS.length ||
    approved.excludedMutableFiles.some(
      (path, index) => path !== EXCLUDED_MUTABLE_PACKAGE_OUTPUTS[index],
    )
  ) {
    throw new Error("Squirrel maker package-tree evidence is malformed.");
  }
  if (!Array.isArray(entries) || entries.length !== approved.fileCount) {
    throw new Error("Installed electron-winstaller file count differs from the pinned tree.");
  }

  const seen = new Set();
  let totalBytes = 0;
  const canonical = [];
  for (const candidate of entries) {
    const entry = requireObject(candidate, "Installed electron-winstaller tree entry");
    requireExactKeys(
      entry,
      ["path", "length", "sha256"],
      "Installed electron-winstaller tree entry",
    );
    requireSafeRelativePath(entry.path, "Installed electron-winstaller tree entry");
    const key = folded(entry.path);
    if (seen.has(key)) {
      throw new Error(`Installed electron-winstaller tree has a case-folded duplicate: ${entry.path}`);
    }
    if (
      !Number.isSafeInteger(entry.length) ||
      entry.length <= 0 ||
      entry.length > MAX_INPUT_BYTES ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error(`Installed electron-winstaller tree entry is malformed: ${entry.path}`);
    }
    seen.add(key);
    totalBytes += entry.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACKAGE_TREE_BYTES) {
      throw new Error("Installed electron-winstaller package tree exceeds its byte limit.");
    }
    canonical.push(entry);
  }
  canonical.sort((left, right) => comparePaths(left.path, right.path));
  const treeHash = createHash("sha256");
  for (const entry of canonical) {
    treeHash.update(`${entry.path}\t${entry.length}\t${entry.sha256}\n`, "utf8");
  }
  const actualSha256 = treeHash.digest("hex");
  if (totalBytes !== approved.totalBytes || actualSha256 !== approved.sha256) {
    throw new Error("Installed electron-winstaller package tree differs from the pinned tree.");
  }
  return {
    fileCount: canonical.length,
    totalBytes,
    sha256: actualSha256,
    excludedMutableFiles: [...EXCLUDED_MUTABLE_PACKAGE_OUTPUTS],
  };
}

async function inventoryPackageTree(packageRoot) {
  const files = [];
  const pending = [{ absolute: packageRoot, relative: "" }];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      if (
        entry.name.length === 0 ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name.includes("\0") ||
        entry.name === "." ||
        entry.name === ".."
      ) {
        throw new Error("Installed electron-winstaller tree contains an unsafe entry name.");
      }
      const relativePath = directory.relative
        ? `${directory.relative}/${entry.name}`
        : entry.name;
      requireSafeRelativePath(relativePath, "Installed electron-winstaller tree entry");
      const absolutePath = resolve(directory.absolute, entry.name);
      requireInside(packageRoot, absolutePath, `Installed electron-winstaller tree entry ${relativePath}`);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Installed electron-winstaller tree contains a symbolic link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        pending.push({ absolute: absolutePath, relative: relativePath });
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Installed electron-winstaller tree contains a special file: ${relativePath}`);
      }
      if (EXCLUDED_MUTABLE_PACKAGE_OUTPUTS.includes(relativePath)) {
        continue;
      }
      if (files.length >= MAX_PACKAGE_TREE_FILES) {
        throw new Error("Installed electron-winstaller package tree exceeds its file limit.");
      }
      const evidence = await hashRegularFile(
        absolutePath,
        `Installed electron-winstaller tree entry ${relativePath}`,
        MAX_INPUT_BYTES,
        ["sha256"],
      );
      files.push({
        path: relativePath,
        length: evidence.length,
        sha256: evidence.hashes.sha256,
      });
    }
  }
  return files;
}

async function loadPinnedMakerInputs(manifestPath, electronWinstallerDirectory) {
  const manifestBytes = await readRegularFile(
    manifestPath,
    "Squirrel maker input manifest",
    MAX_MANIFEST_BYTES,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Squirrel maker input manifest is not valid JSON.");
  }
  requireObject(manifest, "Squirrel maker input manifest");
  requireExactKeys(
    manifest,
    ["schemaVersion", "package", "packageTree", "files"],
    "Squirrel maker input manifest",
  );
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Squirrel maker input manifest has an unsupported version or file list.");
  }
  const packageIdentity = requireObject(manifest.package, "Squirrel maker package identity");
  requireExactKeys(packageIdentity, ["name", "version", "license"], "Squirrel maker package identity");
  if (
    packageIdentity.name !== "electron-winstaller" ||
    packageIdentity.version !== "5.4.4" ||
    packageIdentity.license !== "MIT"
  ) {
    throw new Error("Squirrel maker package identity is not approved.");
  }
  if (manifest.files.length !== EXPECTED_INPUTS.size) {
    throw new Error("Squirrel maker input manifest does not contain the exact approved file set.");
  }

  const packageMetadata = await lstat(electronWinstallerDirectory);
  if (packageMetadata.isSymbolicLink() || !packageMetadata.isDirectory()) {
    throw new Error("electron-winstaller input root is not a regular directory.");
  }
  const packageRoot = await realpath(electronWinstallerDirectory);
  const packageTree = verifyPackageTreeInventory(
    await inventoryPackageTree(packageRoot),
    manifest.packageTree,
  );
  const seenRoles = new Set();
  const seenPaths = new Set();
  const files = [];
  const buffers = new Map();
  for (const candidate of manifest.files) {
    const entry = requireObject(candidate, "Squirrel maker input entry");
    requireExactKeys(entry, ["role", "path", "length", "sha256"], "Squirrel maker input entry");
    const expectedPath = EXPECTED_INPUTS.get(entry.role);
    if (expectedPath === undefined || entry.path !== expectedPath || seenRoles.has(entry.role)) {
      throw new Error(`Squirrel maker input role is missing, duplicated, or changed: ${String(entry.role)}`);
    }
    requireSafeRelativePath(entry.path, `Squirrel maker input ${entry.role}`);
    if (seenPaths.has(folded(entry.path))) {
      throw new Error(`Squirrel maker input path is duplicated: ${entry.path}`);
    }
    if (
      !Number.isSafeInteger(entry.length) ||
      entry.length <= 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error(`Squirrel maker input evidence is malformed: ${entry.path}`);
    }
    const absolutePath = resolve(packageRoot, ...entry.path.split("/"));
    requireInside(packageRoot, absolutePath, `Squirrel maker input ${entry.path}`);
    const realFile = await realpath(absolutePath);
    requireInside(packageRoot, realFile, `Squirrel maker input ${entry.path}`);
    const bytes = await readRegularFile(realFile, `Squirrel maker input ${entry.path}`, MAX_INPUT_BYTES);
    if (bytes.length !== entry.length || sha256(bytes) !== entry.sha256) {
      throw new Error(`Squirrel maker input differs from the pinned bytes: ${entry.path}`);
    }
    seenRoles.add(entry.role);
    seenPaths.add(folded(entry.path));
    files.push({ role: entry.role, path: entry.path, length: entry.length, sha256: entry.sha256 });
    buffers.set(entry.role, bytes);
  }
  for (const role of EXPECTED_INPUTS.keys()) {
    if (!seenRoles.has(role)) throw new Error(`Squirrel maker input role is missing: ${role}`);
  }

  let installedPackage;
  try {
    installedPackage = JSON.parse(buffers.get("packageMetadata").toString("utf8"));
  } catch {
    throw new Error("Pinned electron-winstaller package metadata is not valid JSON.");
  }
  if (
    installedPackage.name !== packageIdentity.name ||
    installedPackage.version !== packageIdentity.version ||
    installedPackage.license !== packageIdentity.license
  ) {
    throw new Error("Installed electron-winstaller metadata differs from the pinned identity.");
  }
  return {
    manifestSha256: sha256(manifestBytes),
    package: {
      name: packageIdentity.name,
      version: packageIdentity.version,
      license: packageIdentity.license,
    },
    packageTree,
    files,
    buffers,
  };
}

export async function verifyPinnedSquirrelMakerInputs(options) {
  const result = await loadPinnedMakerInputs(
    options.manifestPath,
    options.electronWinstallerDirectory,
  );
  return {
    manifestSha256: result.manifestSha256,
    package: result.package,
    packageTree: result.packageTree,
    files: result.files,
  };
}

function parsePe(bytes, label) {
  let executable;
  try {
    executable = NtExecutable.from(bytes);
  } catch (error) {
    throw new Error(`${label} is not an approved unsigned PE image.`, { cause: error });
  }
  const extra = executable.getExtraData();
  if (extra && extra.byteLength > 0) throw new Error(`${label} contains an unexpected PE overlay.`);
  const sections = executable.getAllSections();
  const names = sections.map((section) => section.info.name);
  if (
    names.length !== EXPECTED_PE_SECTIONS.length ||
    names.some((name, index) => name !== EXPECTED_PE_SECTIONS[index]) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(`${label} has unexpected PE sections.`);
  }
  if (
    !executable.is32bit() ||
    executable.newHeader.fileHeader.machine !== IMAGE_FILE_MACHINE_I386 ||
    executable.newHeader.optionalHeader.subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI
  ) {
    throw new Error(`${label} has the wrong PE architecture or subsystem.`);
  }
  return { executable, sections: new Map(sections.map((section) => [section.info.name, section])) };
}

function alignUp(value, alignment, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(alignment) ||
    alignment <= 0
  ) {
    throw new Error(`${label} has invalid PE alignment inputs.`);
  }
  const aligned = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(aligned)) throw new Error(`${label} PE alignment overflowed.`);
  return aligned;
}

function peHeaderLayout(bytes, label) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 0x40) throw new Error(`${label} has a truncated DOS header.`);
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${label} has an invalid PE header location.`);
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sectionTableEnd = sectionTableOffset + sectionCount * 40;
  if (optionalHeaderSize !== 224 || sectionCount !== EXPECTED_PE_SECTIONS.length || sectionTableEnd > buffer.length) {
    throw new Error(`${label} has an unsupported PE header layout.`);
  }
  const sectionRows = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const nameEnd = buffer.indexOf(0, offset);
    const boundedEnd = nameEnd >= offset && nameEnd < offset + 8 ? nameEnd : offset + 8;
    sectionRows.push({ name: buffer.toString("ascii", offset, boundedEnd), offset });
  }
  if (sectionRows.some((row, index) => row.name !== EXPECTED_PE_SECTIONS[index])) {
    throw new Error(`${label} changed the original PE section-table order.`);
  }
  return {
    buffer,
    peOffset,
    optionalHeaderOffset,
    sectionTableOffset,
    sectionRows,
  };
}

function copyApprovedField(normalized, approved, offset, length, label) {
  if (offset < 0 || length <= 0 || offset + length > normalized.length || offset + length > approved.length) {
    throw new Error(`${label} has an invalid mutable PE field range.`);
  }
  approved.copy(normalized, offset, offset, offset + length);
}

function verifyDerivedPeLayout(actual, approved, actualBytes, approvedBytes, label) {
  const actualLayout = peHeaderLayout(actualBytes, label);
  const approvedLayout = peHeaderLayout(approvedBytes, `Approved ${label}`);
  if (
    actualLayout.peOffset !== approvedLayout.peOffset ||
    actualLayout.optionalHeaderOffset !== approvedLayout.optionalHeaderOffset ||
    actualLayout.sectionTableOffset !== approvedLayout.sectionTableOffset
  ) {
    throw new Error(`${label} changed the fixed PE header layout.`);
  }

  const actualSections = actual.executable.getAllSections();
  const approvedSections = approved.executable.getAllSections();
  const firstRawOffset = Math.min(...approvedSections.map((section) => section.info.pointerToRawData));
  if (
    firstRawOffset <= actualLayout.sectionTableOffset ||
    firstRawOffset > actualLayout.buffer.length ||
    firstRawOffset > approvedLayout.buffer.length
  ) {
    throw new Error(`${label} has an invalid PE header boundary.`);
  }
  const normalizedHeader = Buffer.from(actualLayout.buffer.subarray(0, firstRawOffset));
  const approvedHeader = approvedLayout.buffer.subarray(0, firstRawOffset);
  const optionalOffset = actualLayout.optionalHeaderOffset;
  const mutableHeaderFields = [
    [optionalOffset + 8, 4],
    [optionalOffset + 56, 4],
    [optionalOffset + 96 + 2 * 8 + 4, 4],
    [optionalOffset + 96 + 5 * 8, 4],
  ];
  const resourceRow = actualLayout.sectionRows.find((row) => row.name === ".rsrc");
  const relocationRow = actualLayout.sectionRows.find((row) => row.name === ".reloc");
  if (!resourceRow || !relocationRow) throw new Error(`${label} is missing mutable PE section rows.`);
  mutableHeaderFields.push(
    [resourceRow.offset + 8, 4],
    [resourceRow.offset + 16, 4],
    [relocationRow.offset + 12, 4],
    [relocationRow.offset + 20, 4],
  );
  for (const [offset, length] of mutableHeaderFields) {
    copyApprovedField(normalizedHeader, approvedHeader, offset, length, label);
  }
  if (!normalizedHeader.equals(approvedHeader)) {
    throw new Error(`${label} changed a non-derived PE header or header-gap byte.`);
  }

  const resource = actual.sections.get(".rsrc");
  const approvedResource = approved.sections.get(".rsrc");
  const relocation = actual.sections.get(".reloc");
  if (!resource?.data || !approvedResource?.data || !relocation?.data) {
    throw new Error(`${label} is missing a PE resource or relocation section.`);
  }
  const fileAlignment = actual.executable.getFileAlignment();
  const sectionAlignment = actual.executable.getSectionAlignment();
  if (
    fileAlignment !== approved.executable.getFileAlignment() ||
    sectionAlignment !== approved.executable.getSectionAlignment() ||
    resource.info.virtualAddress !== approvedResource.info.virtualAddress ||
    resource.info.pointerToRawData !== approvedResource.info.pointerToRawData ||
    resource.info.sizeOfRawData !== alignUp(resource.info.virtualSize, fileAlignment, label) ||
    relocation.info.virtualAddress !==
      alignUp(resource.info.virtualAddress + resource.info.virtualSize, sectionAlignment, label) ||
    relocation.info.pointerToRawData !== resource.info.pointerToRawData + resource.info.sizeOfRawData
  ) {
    throw new Error(`${label} has an invalid derived PE section layout.`);
  }
  const resourceDirectory = actual.executable.newHeader.optionalHeaderDataDirectory.get(2);
  const relocationDirectory = actual.executable.newHeader.optionalHeaderDataDirectory.get(5);
  if (
    resourceDirectory.virtualAddress !== resource.info.virtualAddress ||
    resourceDirectory.size !== resource.info.virtualSize ||
    relocationDirectory.virtualAddress !== relocation.info.virtualAddress
  ) {
    throw new Error(`${label} has an invalid derived PE data directory.`);
  }
  const expectedInitializedBytes = actualSections
    .filter((section) => (section.info.characteristics & 0x00000040) !== 0)
    .reduce((sum, section) => sum + section.info.sizeOfRawData, 0);
  const approvedResourceUnchanged =
    resource.info.virtualSize === approvedResource.info.virtualSize &&
    resource.info.sizeOfRawData === approvedResource.info.sizeOfRawData;
  const allowedInitializedBytes = approvedResourceUnchanged
    ? approved.executable.newHeader.optionalHeader.sizeOfInitializedData
    : expectedInitializedBytes;
  const expectedImageSize = alignUp(
    relocation.info.virtualAddress + relocation.info.virtualSize,
    sectionAlignment,
    label,
  );
  if (
    actual.executable.newHeader.optionalHeader.sizeOfInitializedData !== allowedInitializedBytes ||
    actual.executable.newHeader.optionalHeader.sizeOfImage !== expectedImageSize ||
    actualLayout.buffer.length !== relocation.info.pointerToRawData + relocation.info.sizeOfRawData
  ) {
    throw new Error(`${label} has invalid derived PE aggregate sizes.`);
  }
  return {
    fileAlignment,
    sectionAlignment,
    resourceVirtualSize: resource.info.virtualSize,
    resourceRawSize: resource.info.sizeOfRawData,
  };
}

function verifyResourceTailPadding(section, label) {
  if (!section?.data) throw new Error(`${label} is missing its PE resource bytes.`);
  const bytes = Buffer.from(section.data);
  if (section.info.virtualSize > bytes.length) {
    throw new Error(`${label} has a PE resource virtual size beyond its raw bytes.`);
  }
  const padding = bytes.subarray(section.info.virtualSize);
  let mode = "zero";
  if (!padding.every((value) => value === 0)) {
    mode = "squirrel-padding-v1";
    for (let index = 0; index < padding.length; index += 1) {
      if (padding[index] !== SQUIRREL_RESOURCE_PADDING[index % SQUIRREL_RESOURCE_PADDING.length]) {
        throw new Error(`${label} has unexpected PE resource padding bytes.`);
      }
    }
  }
  return { length: padding.length, mode };
}

function canonicalizePeWithoutResourceSemantics(parsed, approved, label) {
  const resources = NtExecutableResource.from(parsed.executable);
  resources.dateTime = 0;
  resources.majorVersion = 0;
  resources.minorVersion = 0;
  resources.entries = [{
    type: "OWNCONTEXT-CANONICAL",
    id: 1,
    lang: 0,
    codepage: 0,
    bin: CANONICAL_RESOURCE_BYTES,
  }];
  resources.outputResource(parsed.executable, false, true);
  parsed.executable.newHeader.optionalHeader.sizeOfInitializedData =
    approved.executable.newHeader.optionalHeader.sizeOfInitializedData;
  parsed.executable.newHeader.optionalHeader.sizeOfImage =
    approved.executable.newHeader.optionalHeader.sizeOfImage;
  let generated;
  try {
    generated = Buffer.from(parsed.executable.generate());
  } catch (error) {
    throw new Error(`${label} could not be canonically regenerated.`, { cause: error });
  }
  return generated;
}

export function verifyInvariantPeOrigin(actualBytes, approvedBytes, label = "Maker executable") {
  const actual = parsePe(actualBytes, label);
  const approved = parsePe(approvedBytes, `Approved ${label}`);
  if (
    actual.executable.newHeader.optionalHeader.addressOfEntryPoint !==
    approved.executable.newHeader.optionalHeader.addressOfEntryPoint
  ) {
    throw new Error(`${label} changed its PE entry point.`);
  }
  const invariantSections = [];
  for (const name of INVARIANT_PE_SECTIONS) {
    const current = actual.sections.get(name);
    const source = approved.sections.get(name);
    if (!current?.data || !source?.data) throw new Error(`${label} is missing invariant PE section ${name}.`);
    const currentBytes = Buffer.from(current.data);
    const sourceBytes = Buffer.from(source.data);
    if (
      current.info.virtualSize !== source.info.virtualSize ||
      current.info.sizeOfRawData !== source.info.sizeOfRawData ||
      current.info.characteristics !== source.info.characteristics ||
      !currentBytes.equals(sourceBytes)
    ) {
      throw new Error(`${label} changed invariant PE section ${name}.`);
    }
    invariantSections.push({
      name,
      length: currentBytes.length,
      sha256: sha256(currentBytes),
      virtualSize: current.info.virtualSize,
      characteristics: current.info.characteristics,
    });
  }
  const layout = verifyDerivedPeLayout(actual, approved, actualBytes, approvedBytes, label);
  const resourcePadding = verifyResourceTailPadding(actual.sections.get(".rsrc"), label);
  const canonicalActual = canonicalizePeWithoutResourceSemantics(actual, approved, label);
  const canonicalApproved = canonicalizePeWithoutResourceSemantics(
    approved,
    parsePe(approvedBytes, `Approved ${label} canonical target`),
    `Approved ${label}`,
  );
  if (!canonicalActual.equals(canonicalApproved)) {
    throw new Error(`${label} changed outside the allowed PE resource transform.`);
  }
  return {
    machine: actual.executable.newHeader.fileHeader.machine,
    addressOfEntryPoint: actual.executable.newHeader.optionalHeader.addressOfEntryPoint,
    subsystem: actual.executable.newHeader.optionalHeader.subsystem,
    canonicalSha256: sha256(canonicalActual),
    layout,
    resourcePadding,
    invariantSections,
  };
}

function resourceKey(entry) {
  return `${typeof entry.type}:${String(entry.type)}|${typeof entry.id}:${String(entry.id)}|${typeof entry.lang}:${String(entry.lang)}`;
}

function verifyKnownResourceGap(bytes, start, end, label) {
  if (start >= end) return "empty";
  const gap = bytes.subarray(start, end);
  if (gap.every((value) => value === 0)) return "zero";
  for (let index = 0; index < gap.length; index += 1) {
    if (gap[index] !== SQUIRREL_RESOURCE_PADDING[index % SQUIRREL_RESOURCE_PADDING.length]) {
      throw new Error(`${label} contains unexplained non-padding PE resource bytes.`);
    }
  }
  return "squirrel-padding-v1";
}

function inspectStrictResourceLayout(parsed, expectedEntryCount, label) {
  const section = parsed.sections.get(".rsrc");
  if (!section?.data) throw new Error(`${label} is missing PE resources.`);
  const bytes = Buffer.from(section.data);
  const virtualSize = section.info.virtualSize;
  if (virtualSize <= 0 || virtualSize > bytes.length) {
    throw new Error(`${label} has an invalid PE resource size.`);
  }
  const used = new Uint8Array(virtualSize);
  const visitedDirectories = new Set();
  const visitedDescriptors = new Set();
  let directoryCount = 0;
  let dataEntryCount = 0;

  const mark = (offset, length, description) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length <= 0 ||
      offset + length > virtualSize
    ) {
      throw new Error(`${label} has an out-of-range resource ${description}.`);
    }
    for (let index = offset; index < offset + length; index += 1) {
      if (used[index] !== 0) {
        throw new Error(`${label} has overlapping resource ${description}.`);
      }
      used[index] = 1;
    }
  };

  const markName = (encodedName) => {
    const offset = encodedName & 0x7fffffff;
    if (offset + 2 > virtualSize) throw new Error(`${label} has an out-of-range resource name.`);
    const characterCount = bytes.readUInt16LE(offset);
    if (characterCount <= 0 || characterCount > 4_096) {
      throw new Error(`${label} has an invalid resource-name length.`);
    }
    mark(offset, 2 + characterCount * 2, "name string");
  };

  const visitDescriptor = (offset) => {
    if (visitedDescriptors.has(offset)) {
      throw new Error(`${label} aliases a PE resource descriptor.`);
    }
    visitedDescriptors.add(offset);
    mark(offset, 16, "data descriptor");
    const dataRva = bytes.readUInt32LE(offset);
    const dataSize = bytes.readUInt32LE(offset + 4);
    const codepage = bytes.readUInt32LE(offset + 8);
    const reserved = bytes.readUInt32LE(offset + 12);
    const dataOffset = dataRva - section.info.virtualAddress;
    if (dataSize <= 0 || codepage !== 1252 || reserved !== 0) {
      throw new Error(`${label} has an invalid PE resource descriptor.`);
    }
    mark(dataOffset, dataSize, "payload");
    dataEntryCount += 1;
  };

  const visitDirectory = (offset, depth) => {
    if (depth > 2 || visitedDirectories.has(offset)) {
      throw new Error(`${label} has an aliased or over-deep resource directory.`);
    }
    visitedDirectories.add(offset);
    if (offset + 16 > virtualSize) throw new Error(`${label} has a truncated resource directory.`);
    const characteristics = bytes.readUInt32LE(offset);
    const dateTime = bytes.readUInt32LE(offset + 4);
    const majorVersion = bytes.readUInt16LE(offset + 8);
    const minorVersion = bytes.readUInt16LE(offset + 10);
    const namedCount = bytes.readUInt16LE(offset + 12);
    const idCount = bytes.readUInt16LE(offset + 14);
    const entryCount = namedCount + idCount;
    if (entryCount <= 0 || entryCount > 4_096) {
      throw new Error(`${label} has an invalid resource-directory entry count.`);
    }
    if (
      characteristics !== 0 ||
      dateTime !== 0 ||
      majorVersion !== 4 ||
      minorVersion !== 0
    ) {
      throw new Error(`${label} has unexpected resource-directory metadata.`);
    }
    mark(offset, 16 + entryCount * 8, "directory table");
    directoryCount += 1;
    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = offset + 16 + index * 8;
      const encodedName = bytes.readUInt32LE(entryOffset);
      const encodedTarget = bytes.readUInt32LE(entryOffset + 4);
      const named = (encodedName & 0x80000000) !== 0;
      if ((index < namedCount) !== named) {
        throw new Error(`${label} has an invalid named resource ordering.`);
      }
      if (named) markName(encodedName);
      const directoryTarget = (encodedTarget & 0x80000000) !== 0;
      const targetOffset = encodedTarget & 0x7fffffff;
      if (depth < 2) {
        if (!directoryTarget) throw new Error(`${label} has a shallow PE resource leaf.`);
        visitDirectory(targetOffset, depth + 1);
      } else {
        if (directoryTarget) throw new Error(`${label} has an over-deep PE resource branch.`);
        visitDescriptor(targetOffset);
      }
    }
  };

  visitDirectory(0, 0);
  if (dataEntryCount !== expectedEntryCount) {
    throw new Error(`${label} resource-tree leaf count differs from its parsed inventory.`);
  }
  const gapModes = new Set();
  let start = 0;
  while (start < virtualSize) {
    if (used[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < virtualSize && used[end] === 0) end += 1;
    gapModes.add(verifyKnownResourceGap(bytes, start, end, label));
    start = end;
  }
  return {
    directoryCount,
    dataEntryCount,
    gapModes: [...gapModes].sort(),
  };
}

function extractSetupArchive(actualBytes, approvedBytes) {
  const actualPe = parsePe(actualBytes, "Emitted Setup.exe");
  const approvedPe = parsePe(approvedBytes, "Approved Setup.exe");
  const actual = NtExecutableResource.from(actualPe.executable);
  const approved = NtExecutableResource.from(approvedPe.executable);
  if (actual.dateTime !== 0 || actual.majorVersion !== 4 || actual.minorVersion !== 0) {
    throw new Error("Emitted Setup.exe has an unexpected resource-directory transform.");
  }
  const approvedEntries = new Map(approved.entries.map((entry) => [resourceKey(entry), entry]));
  const actualEntries = new Map();
  for (const entry of actual.entries) {
    const key = resourceKey(entry);
    if (actualEntries.has(key)) throw new Error("Emitted Setup.exe has duplicate resources.");
    actualEntries.set(key, entry);
  }
  if (actualEntries.size !== approvedEntries.size) {
    throw new Error("Emitted Setup.exe changed the approved resource inventory.");
  }
  for (const [key, source] of approvedEntries) {
    const current = actualEntries.get(key);
    if (!current) throw new Error("Emitted Setup.exe changed the approved resource inventory.");
    if (current.codepage !== 1252) {
      throw new Error("Emitted Setup.exe has an unexpected resource codepage transform.");
    }
    const mutable = (current.type === "DATA" && current.id === 131) ||
      (current.type === 16 && current.id === 1);
    if (!mutable && !Buffer.from(current.bin).equals(Buffer.from(source.bin))) {
      throw new Error(`Emitted Setup.exe changed immutable resource ${key}.`);
    }
  }
  const layout = inspectStrictResourceLayout(
    actualPe,
    actualEntries.size,
    "Emitted Setup.exe",
  );
  const versions = actual.entries.filter((entry) => entry.type === 16 && entry.id === 1);
  if (
    versions.length !== 1 ||
    versions[0].bin.byteLength !== EXPECTED_SETUP_VERSION_RESOURCE.length ||
    sha256(Buffer.from(versions[0].bin)) !== EXPECTED_SETUP_VERSION_RESOURCE.sha256
  ) {
    throw new Error("Emitted Setup.exe version resource differs from the pinned product transform.");
  }
  const archives = actual.entries.filter((entry) => entry.type === "DATA" && entry.id === 131);
  if (archives.length !== 1 || archives[0].bin.byteLength === 0) {
    throw new Error("Emitted Setup.exe must contain exactly one non-empty DATA/131 resource.");
  }
  return { archive: Buffer.from(archives[0].bin), layout };
}

export function parseSquirrelReleaseRecord(contents, expectedPackageFileName) {
  let text;
  try {
    text = typeof contents === "string"
      ? contents
      : new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error("Squirrel RELEASES is not valid UTF-8.");
  }
  const match = RELEASE_RECORD.exec(text);
  if (!match) throw new Error("Squirrel RELEASES must contain exactly one complete record.");
  const [, sha1Upper, fileName, sizeText] = match;
  if (fileName !== expectedPackageFileName) {
    throw new Error("Squirrel RELEASES references an unexpected package.");
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Squirrel RELEASES contains an invalid package size.");
  }
  return { sha1: sha1Upper.toLowerCase(), fileName, size };
}

function requireZipRange(bytes, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(`Setup.exe embedded ZIP has a truncated ${label}.`);
  }
}

function decodeZipName(bytes, offset, length) {
  requireZipRange(bytes, offset, length, "filename");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length));
  } catch {
    throw new Error("Setup.exe embedded ZIP filename is not valid UTF-8.");
  }
}

function requireValidDosTimestamp(date, time, name) {
  const day = date & 0x1f;
  const month = (date >>> 5) & 0x0f;
  const year = 1980 + (date >>> 9);
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >>> 5) & 0x3f;
  const hours = (time >>> 11) & 0x1f;
  const parsed = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  if (
    day <= 0 ||
    month <= 0 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Setup.exe embedded ZIP entry has an invalid DOS timestamp: ${name}`);
  }
}

export function verifyStrictSetupZipContainer(archiveBytes, expectedNames) {
  const bytes = Buffer.from(archiveBytes);
  if (!Array.isArray(expectedNames) || expectedNames.length !== 4 || bytes.length <= 22) {
    throw new Error("Setup.exe embedded ZIP has an unsupported strict inventory.");
  }
  const localEntries = [];
  let offset = 0;
  for (const expectedName of expectedNames) {
    requireSafeRelativePath(expectedName, "Expected Setup.exe ZIP entry");
    requireZipRange(bytes, offset, 30, "local header");
    if (bytes.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error("Setup.exe embedded ZIP local headers are not contiguous or ordered.");
    }
    const versionNeeded = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const dosTime = bytes.readUInt16LE(offset + 10);
    const dosDate = bytes.readUInt16LE(offset + 12);
    const crc32 = bytes.readUInt32LE(offset + 14);
    const compressedLength = bytes.readUInt32LE(offset + 18);
    const uncompressedLength = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = decodeZipName(bytes, offset + 30, nameLength);
    if (
      versionNeeded !== 20 ||
      flags !== 0 ||
      method !== 8 ||
      extraLength !== 0 ||
      name !== expectedName ||
      compressedLength <= 0 ||
      uncompressedLength <= 0
    ) {
      throw new Error(`Setup.exe embedded ZIP local metadata is unexpected: ${name}`);
    }
    requireValidDosTimestamp(dosDate, dosTime, name);
    const dataOffset = offset + 30 + nameLength;
    requireZipRange(bytes, dataOffset, compressedLength, `compressed data for ${name}`);
    localEntries.push({
      name,
      localHeaderOffset: offset,
      versionNeeded,
      flags,
      method,
      dosTime,
      dosDate,
      crc32,
      compressedLength,
      uncompressedLength,
    });
    offset = dataOffset + compressedLength;
  }

  const centralOffset = offset;
  for (const local of localEntries) {
    requireZipRange(bytes, offset, 46, "central-directory header");
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Setup.exe embedded ZIP central directory is not contiguous or ordered.");
    }
    const versionMadeBy = bytes.readUInt16LE(offset + 4);
    const versionNeeded = bytes.readUInt16LE(offset + 6);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const dosTime = bytes.readUInt16LE(offset + 12);
    const dosDate = bytes.readUInt16LE(offset + 14);
    const crc32 = bytes.readUInt32LE(offset + 16);
    const compressedLength = bytes.readUInt32LE(offset + 20);
    const uncompressedLength = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const disk = bytes.readUInt16LE(offset + 34);
    const internalAttributes = bytes.readUInt16LE(offset + 36);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = decodeZipName(bytes, offset + 46, nameLength);
    if (
      versionMadeBy !== 20 ||
      versionNeeded !== local.versionNeeded ||
      flags !== local.flags ||
      method !== local.method ||
      dosTime !== local.dosTime ||
      dosDate !== local.dosDate ||
      crc32 !== local.crc32 ||
      compressedLength !== local.compressedLength ||
      uncompressedLength !== local.uncompressedLength ||
      name !== local.name ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      disk !== 0 ||
      internalAttributes !== 0 ||
      externalAttributes !== 0 ||
      localHeaderOffset !== local.localHeaderOffset
    ) {
      throw new Error(`Setup.exe embedded ZIP central metadata differs from its local header: ${name}`);
    }
    offset += 46 + nameLength;
  }
  const centralSize = offset - centralOffset;
  requireZipRange(bytes, offset, 22, "end-of-central-directory record");
  if (
    bytes.readUInt32LE(offset) !== 0x06054b50 ||
    bytes.readUInt16LE(offset + 4) !== 0 ||
    bytes.readUInt16LE(offset + 6) !== 0 ||
    bytes.readUInt16LE(offset + 8) !== localEntries.length ||
    bytes.readUInt16LE(offset + 10) !== localEntries.length ||
    bytes.readUInt32LE(offset + 12) !== centralSize ||
    bytes.readUInt32LE(offset + 16) !== centralOffset ||
    bytes.readUInt16LE(offset + 20) !== 0 ||
    offset + 22 !== bytes.length
  ) {
    throw new Error("Setup.exe embedded ZIP EOCD, gap, comment, or trailing bytes are unexpected.");
  }
  return {
    length: bytes.length,
    centralOffset,
    centralSize,
    entries: localEntries.map((entry) => ({
      name: entry.name,
      dataOffset: entry.localHeaderOffset + 30 + Buffer.byteLength(entry.name, "utf8"),
      compressedLength: entry.compressedLength,
      uncompressedLength: entry.uncompressedLength,
      crc32: entry.crc32.toString(16).padStart(8, "0"),
      dosDate: entry.dosDate,
      dosTime: entry.dosTime,
    })),
  };
}

export async function verifyDeflateEntryFullyConsumed(compressedBytes, expected) {
  const bytes = Buffer.from(compressedBytes);
  if (
    bytes.length <= 0 ||
    !expected ||
    !Number.isSafeInteger(expected.uncompressedLength) ||
    expected.uncompressedLength <= 0 ||
    typeof expected.crc32 !== "string" ||
    !/^[0-9a-f]{8}$/u.test(expected.crc32)
  ) {
    throw new Error("Setup.exe embedded DEFLATE evidence is malformed.");
  }
  const inflater = createInflateRaw();
  let length = 0;
  let crc32 = 0xffffffff;
  await new Promise((resolvePromise, rejectPromise) => {
    inflater.on("data", (chunk) => {
      length += chunk.length;
      if (length > expected.uncompressedLength) {
        inflater.destroy(new Error("Setup.exe embedded DEFLATE output exceeds its declared size."));
        return;
      }
      crc32 = updateCrc32(crc32, chunk);
    });
    inflater.once("error", rejectPromise);
    inflater.once("end", resolvePromise);
    inflater.end(bytes);
  });
  const consumed = inflater.bytesWritten;
  const crc = formatCrc32(crc32);
  if (
    consumed !== bytes.length ||
    length !== expected.uncompressedLength ||
    crc !== expected.crc32
  ) {
    throw new Error("Setup.exe embedded DEFLATE stream has trailing input, a size mismatch, or a CRC mismatch.");
  }
  return { compressedLength: bytes.length, uncompressedLength: length, crc32: crc };
}

export function verifySetupArchiveInventory(entries, expectedNames) {
  if (!Array.isArray(entries) || entries.length !== expectedNames.length) {
    throw new Error("Setup.exe embedded ZIP does not contain exactly the expected entries.");
  }
  const expected = new Set(expectedNames);
  const seen = new Set();
  for (const entry of entries) {
    requireSafeRelativePath(entry.name, "Setup.exe embedded ZIP entry");
    const key = folded(entry.name);
    if (seen.has(key)) throw new Error(`Setup.exe embedded ZIP has a case-folded duplicate: ${entry.name}`);
    if (
      !expected.has(entry.name) ||
      entry.directory !== false ||
      !Number.isSafeInteger(entry.length) ||
      entry.length <= 0 ||
      entry.compressionMethod !== 8 ||
      entry.generalPurposeBitFlag !== 0
    ) {
      throw new Error(`Setup.exe embedded ZIP entry is unexpected or unsafe: ${entry.name}`);
    }
    seen.add(key);
  }
  for (const name of expectedNames) {
    if (!seen.has(folded(name))) throw new Error(`Setup.exe embedded ZIP is missing ${name}.`);
  }
  return [...expectedNames];
}

function openZipFromBuffer(buffer) {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(
      buffer,
      {
        autoClose: true,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => error ? rejectPromise(error) : resolvePromise(zipFile),
    );
  });
}

function openZipFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      path,
      {
        autoClose: true,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => error ? rejectPromise(error) : resolvePromise(zipFile),
    );
  });
}

function openEntryStream(zipFile, entry) {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) =>
      error ? rejectPromise(error) : resolvePromise(stream));
  });
}

async function readEntryBuffer(zipFile, entry, maximumBytes) {
  if (entry.uncompressedSize <= 0 || entry.uncompressedSize > maximumBytes || entry.isEncrypted()) {
    throw new Error(`ZIP entry has an unsupported size or encryption: ${entry.fileName}`);
  }
  const chunks = [];
  let length = 0;
  const stream = await openEntryStream(zipFile, entry);
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error(`ZIP entry exceeds its read limit: ${entry.fileName}`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== entry.uncompressedSize) throw new Error(`ZIP entry size changed: ${entry.fileName}`);
  return bytes;
}

async function compareEntryToBuffer(zipFile, entry, expected, label) {
  const actual = await readEntryBuffer(zipFile, entry, Math.max(expected.length, 1));
  if (!actual.equals(expected)) throw new Error(`${label} differs from its approved bytes.`);
  return {
    length: actual.length,
    sha256: sha256(actual),
    crc32: formatCrc32(updateCrc32(0xffffffff, actual)),
  };
}

async function compareEntryToFile(zipFile, entry, expectedPath, label) {
  const expectedMetadata = await lstat(expectedPath);
  if (expectedMetadata.isSymbolicLink() || !expectedMetadata.isFile()) {
    throw new Error(`${label} sibling is not a regular file.`);
  }
  if (entry.uncompressedSize !== expectedMetadata.size || entry.isEncrypted()) {
    throw new Error(`${label} differs in size or encryption from its sibling.`);
  }
  const expected = await open(expectedPath, "r");
  const hash = createHash("sha256");
  let crc32 = 0xffffffff;
  let offset = 0;
  try {
    const stream = await openEntryStream(zipFile, entry);
    for await (const chunk of stream) {
      const sibling = Buffer.allocUnsafe(chunk.length);
      let filled = 0;
      while (filled < sibling.length) {
        const { bytesRead } = await expected.read(
          sibling,
          filled,
          sibling.length - filled,
          offset + filled,
        );
        if (bytesRead === 0) throw new Error(`${label} sibling ended early.`);
        filled += bytesRead;
      }
      if (!Buffer.from(chunk).equals(sibling)) throw new Error(`${label} differs from its sibling bytes.`);
      offset += chunk.length;
      hash.update(chunk);
      crc32 = updateCrc32(crc32, chunk);
    }
  } finally {
    await expected.close();
  }
  if (offset !== expectedMetadata.size) throw new Error(`${label} sibling has trailing bytes.`);
  return { length: offset, sha256: hash.digest("hex"), crc32: formatCrc32(crc32) };
}

async function inspectSetupArchive(archiveBytes, expectations) {
  const strict = verifyStrictSetupZipContainer(archiveBytes, expectations.names);
  const strictEntries = new Map(strict.entries.map((entry) => [entry.name, entry]));
  for (const entry of strict.entries) {
    await verifyDeflateEntryFullyConsumed(
      archiveBytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedLength),
      entry,
    );
  }
  const zipFile = await openZipFromBuffer(archiveBytes);
  if (zipFile.entryCount !== expectations.names.length || zipFile.comment !== "") {
    zipFile.close();
    throw new Error("Setup.exe embedded ZIP count or comment is unexpected.");
  }
  const results = [];
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      rejectPromise(error);
    };
    zipFile.on("error", reject);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    zipFile.on("entry", (entry) => {
      void (async () => {
        const summary = {
          name: entry.fileName,
          length: entry.uncompressedSize,
          directory: entry.fileName.endsWith("/"),
          compressionMethod: entry.compressionMethod,
          generalPurposeBitFlag: entry.generalPurposeBitFlag,
        };
        requireSafeRelativePath(summary.name, "Setup.exe embedded ZIP entry");
        let evidence;
        if (entry.fileName === expectations.fullPackageFileName) {
          evidence = await compareEntryToFile(zipFile, entry, expectations.fullPackagePath, "Embedded full package");
        } else {
          const approved = expectations.buffers.get(entry.fileName);
          if (!approved) throw new Error(`Setup.exe embedded ZIP contains an unexpected entry: ${entry.fileName}`);
          evidence = await compareEntryToBuffer(zipFile, entry, approved, `Embedded ${entry.fileName}`);
        }
        const raw = strictEntries.get(entry.fileName);
        if (
          !raw ||
          raw.uncompressedLength !== evidence.length ||
          raw.crc32 !== evidence.crc32
        ) {
          throw new Error(`Setup.exe embedded ZIP CRC or raw length differs: ${entry.fileName}`);
        }
        results.push({
          ...summary,
          sha256: evidence.sha256,
          crc32: evidence.crc32,
          compressedLength: raw.compressedLength,
          dosDate: raw.dosDate,
          dosTime: raw.dosTime,
        });
        zipFile.readEntry();
      })().catch(reject);
    });
    zipFile.readEntry();
  });
  verifySetupArchiveInventory(results, expectations.names);
  return expectations.names.map((name) => {
    const result = results.find((entry) => entry.name === name);
    return {
      name: result.name,
      length: result.length,
      compressedLength: result.compressedLength,
      sha256: result.sha256,
      crc32: result.crc32,
      dosDate: result.dosDate,
      dosTime: result.dosTime,
    };
  });
}

function verifyExecutionStubResources(stubBytes, applicationBytes) {
  const stubPe = parsePe(stubBytes, "Packaged execution stub");
  let applicationExecutable;
  try {
    applicationExecutable = NtExecutable.from(applicationBytes);
  } catch (error) {
    throw new Error("Packaged application resource source is not a valid PE image.", { cause: error });
  }
  const stubResources = NtExecutableResource.from(stubPe.executable);
  const applicationResources = NtExecutableResource.from(applicationExecutable);
  if (
    stubResources.dateTime !== 0 ||
    stubResources.majorVersion !== 4 ||
    stubResources.minorVersion !== 0
  ) {
    throw new Error("Packaged execution stub has unexpected resource-directory metadata.");
  }
  const sourceEntries = new Map();
  for (const entry of applicationResources.entries) {
    const key = resourceKey(entry);
    if (sourceEntries.has(key)) {
      throw new Error("Packaged application has duplicate PE resources.");
    }
    sourceEntries.set(key, entry);
  }
  const stubEntries = new Map();
  const digest = createHash("sha256");
  for (const entry of stubResources.entries) {
    const key = resourceKey(entry);
    if (stubEntries.has(key)) {
      throw new Error("Packaged execution stub has duplicate PE resources.");
    }
    const source = sourceEntries.get(key);
    const bytes = Buffer.from(entry.bin);
    if (
      !source ||
      entry.codepage !== 1252 ||
      !bytes.equals(Buffer.from(source.bin))
    ) {
      throw new Error(`Packaged execution stub resource is not copied from the application: ${key}`);
    }
    stubEntries.set(key, entry);
    digest.update(`${key}\t${bytes.length}\t${sha256(bytes)}\n`, "utf8");
  }
  if (stubEntries.size === 0 || stubEntries.size !== sourceEntries.size) {
    throw new Error("Packaged execution stub resource inventory differs from the application.");
  }
  const layout = inspectStrictResourceLayout(
    stubPe,
    stubEntries.size,
    "Packaged execution stub",
  );
  return {
    source: "packaged-application-executable",
    entryCount: stubEntries.size,
    semanticSha256: digest.digest("hex"),
    layout,
  };
}

function verifyNugetMetadata(found, coreName) {
  const evidence = [];
  for (const [name, expected] of PINNED_NUGET_METADATA) {
    const bytes = found.get(name);
    if (
      !bytes ||
      bytes.length !== expected.length ||
      sha256(bytes) !== expected.sha256
    ) {
      throw new Error(`Squirrel NuGet metadata differs from the pinned product transform: ${name}`);
    }
    evidence.push({ name, length: bytes.length, sha256: expected.sha256, transform: "pinned-bytes" });
  }
  const coreBytes = found.get(coreName);
  if (
    !coreBytes ||
    coreBytes.length !== PINNED_NUGET_CORE_PROPERTIES.length ||
    sha256(coreBytes) !== PINNED_NUGET_CORE_PROPERTIES.sha256
  ) {
    throw new Error("Squirrel NuGet core-properties metadata differs from the pinned product transform.");
  }
  evidence.push({
    name: coreName,
    length: coreBytes.length,
    sha256: PINNED_NUGET_CORE_PROPERTIES.sha256,
    transform: "pinned-bytes-with-randomized-path",
  });

  const relationshipsName = "_rels/.rels";
  const relationships = found.get(relationshipsName);
  if (!relationships || relationships.length <= 0 || relationships.length > MAX_MANIFEST_BYTES) {
    throw new Error("Squirrel NuGet relationships metadata is missing or oversized.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(relationships);
  } catch {
    throw new Error("Squirrel NuGet relationships metadata is not valid UTF-8.");
  }
  const identifiers = text.match(/Id="R[0-9a-f]{16}"/gu) ?? [];
  if (identifiers.length !== 2 || identifiers[0] === identifiers[1]) {
    throw new Error("Squirrel NuGet relationship identifiers are not two distinct bounded values.");
  }
  const normalized = text
    .replaceAll(coreName, "<core>")
    .replace(/Id="R[0-9a-f]{16}"/gu, "Id=\"R<id>\"");
  if (normalized !== NORMALIZED_NUGET_RELATIONSHIPS) {
    throw new Error("Squirrel NuGet relationships metadata differs from its canonical structure.");
  }
  evidence.push({
    name: relationshipsName,
    length: relationships.length,
    sha256: sha256(relationships),
    transform: "canonical-xml-with-two-random-identifiers",
  });
  return evidence;
}

async function inspectNupkgExecutables(path, applicationExecutableName, approvedInputs) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_MAKER_CONTAINER_BYTES) {
    throw new Error("Squirrel full package is not a bounded regular file.");
  }
  const executableStem = applicationExecutableName.slice(0, -4);
  const squirrelName = "lib/net45/squirrel.exe";
  const stubName = `lib/net45/${executableStem}_ExecutionStub.exe`;
  const applicationName = `lib/net45/${applicationExecutableName}`;
  const nuspecName = `${executableStem}.nuspec`;
  if (!PINNED_NUGET_METADATA.has(nuspecName)) {
    throw new Error("Squirrel NuGet package identity does not match the pinned product transform.");
  }
  const targets = new Map([
    [folded(squirrelName), squirrelName],
    [folded(stubName), stubName],
    [folded(applicationName), applicationName],
    [folded(nuspecName), nuspecName],
    [folded("[Content_Types].xml"), "[Content_Types].xml"],
    [folded("_rels/.rels"), "_rels/.rels"],
  ]);
  const found = new Map();
  let coreName;
  const zipFile = await openZipFile(path);
  if (zipFile.entryCount <= 0 || zipFile.entryCount > MAX_NUPKG_ENTRIES) {
    zipFile.close();
    throw new Error("Squirrel full package has an unsupported entry count.");
  }
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      rejectPromise(error);
    };
    zipFile.on("error", reject);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    zipFile.on("entry", (entry) => {
      void (async () => {
        const coreCandidate = NUGET_CORE_PROPERTIES.test(entry.fileName);
        const expectedName = targets.get(folded(entry.fileName)) ??
          (coreCandidate ? entry.fileName : undefined);
        if (!expectedName) {
          zipFile.readEntry();
          return;
        }
        if (entry.fileName !== expectedName || found.has(expectedName)) {
          throw new Error(`Squirrel full package changed or duplicated maker executable ${entry.fileName}.`);
        }
        if (coreCandidate) {
          if (coreName) throw new Error("Squirrel full package duplicates NuGet core-properties metadata.");
          coreName = entry.fileName;
        }
        const maximumBytes = expectedName === applicationName
          ? MAX_APPLICATION_EXECUTABLE_BYTES
          : expectedName === squirrelName || expectedName === stubName
            ? MAX_MAKER_EXECUTABLE_BYTES
            : MAX_MANIFEST_BYTES;
        found.set(expectedName, await readEntryBuffer(zipFile, entry, maximumBytes));
        zipFile.readEntry();
      })().catch(reject);
    });
    zipFile.readEntry();
  });
  const squirrelBytes = found.get(squirrelName);
  const stubBytes = found.get(stubName);
  const applicationBytes = found.get(applicationName);
  if (!squirrelBytes || !stubBytes || !applicationBytes || !coreName) {
    throw new Error("Squirrel full package is missing maker, application, or metadata inputs.");
  }
  if (!squirrelBytes.equals(approvedInputs.get("squirrelExecutable"))) {
    throw new Error("Packaged squirrel.exe differs from the approved Squirrel.exe input.");
  }
  const stubPe = verifyInvariantPeOrigin(
    stubBytes,
    approvedInputs.get("executionStub"),
    "Packaged execution stub",
  );
  const resources = verifyExecutionStubResources(stubBytes, applicationBytes);
  const nugetMetadata = verifyNugetMetadata(found, coreName);
  return {
    squirrel: { name: squirrelName, length: squirrelBytes.length, sha256: sha256(squirrelBytes) },
    applicationResourceSource: {
      name: applicationName,
      length: applicationBytes.length,
      sha256: sha256(applicationBytes),
    },
    executionStub: {
      name: stubName,
      length: stubBytes.length,
      sha256: sha256(stubBytes),
      pe: stubPe,
      resources,
    },
    nugetMetadata,
  };
}

async function requireExactMakerDirectory(directory, expectedNames) {
  const root = await lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Squirrel maker output is not a regular directory.");
  const entries = await readdir(directory, { withFileTypes: true });
  const expected = new Set(expectedNames);
  const seen = new Set();
  if (entries.length !== expected.size) throw new Error("Squirrel maker output directory inventory is not exact.");
  for (const entry of entries) {
    const key = folded(entry.name);
    if (seen.has(key) || !expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Squirrel maker output contains an unexpected entry: ${entry.name}`);
    }
    const metadata = await lstat(resolve(directory, entry.name));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
      throw new Error(`Squirrel maker output is not a non-empty regular file: ${entry.name}`);
    }
    seen.add(key);
  }
}

async function inspectExistingEvidence(path, expectedBytes) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Existing Squirrel maker evidence is not a regular file.");
    }
    const current = await readFile(path);
    if (!current.equals(expectedBytes)) {
      throw new Error("Existing Squirrel maker evidence differs from the verified result.");
    }
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeSquirrelMakerEvidenceAtomically(evidencePath, evidenceRoot, evidence) {
  if (
    basename(evidencePath) !== "SQUIRREL-MAKER-PROVENANCE.json" ||
    !evidenceRoot
  ) {
    throw new Error("Squirrel maker evidence path or root is unexpected.");
  }
  const rootMetadata = await lstat(evidenceRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Squirrel maker evidence root is not a regular directory.");
  }
  const requestedRoot = resolve(evidenceRoot);
  const requestedDirectory = resolve(dirname(evidencePath));
  requireInside(requestedRoot, requestedDirectory, "Requested Squirrel maker evidence directory");
  const requestedRelative = relative(requestedRoot, requestedDirectory);
  if (requestedRelative.includes(sep)) {
    throw new Error("Squirrel maker evidence directory must be one direct child of its root.");
  }
  const canonicalRoot = await realpath(evidenceRoot);
  const evidenceDirectory = dirname(evidencePath);
  await mkdir(evidenceDirectory, { recursive: true });
  const directoryMetadata = await lstat(evidenceDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("Squirrel maker evidence directory is not a regular directory.");
  }
  const canonicalDirectory = await realpath(evidenceDirectory);
  requireInside(canonicalRoot, canonicalDirectory, "Squirrel maker evidence directory");
  const finalPath = resolve(canonicalDirectory, basename(evidencePath));
  const expectedBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (await inspectExistingEvidence(finalPath, expectedBytes)) return;

  const temporaryPath = resolve(
    canonicalDirectory,
    `.SQUIRREL-MAKER-PROVENANCE.${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(expectedBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temporaryPath, finalPath);
      renamed = true;
    } catch (error) {
      if (!(await inspectExistingEvidence(finalPath, expectedBytes))) throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) {
      await unlink(temporaryPath).catch((error) => {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
      });
    }
  }
  if (!(await inspectExistingEvidence(finalPath, expectedBytes))) {
    throw new Error("Atomic Squirrel maker evidence creation did not persist exact bytes.");
  }
}

export async function verifySquirrelMakerProvenance(options) {
  const expectedNames = [options.setupFileName, options.fullPackageFileName, "RELEASES"];
  await requireExactMakerDirectory(options.makerDirectory, expectedNames);
  const inputs = await loadPinnedMakerInputs(options.manifestPath, options.electronWinstallerDirectory);
  const setupPath = resolve(options.makerDirectory, options.setupFileName);
  const fullPackagePath = resolve(options.makerDirectory, options.fullPackageFileName);
  const releasesPath = resolve(options.makerDirectory, "RELEASES");
  const setupBytes = await readRegularFile(setupPath, "Emitted Setup.exe", MAX_MAKER_CONTAINER_BYTES);
  const releaseBytes = await readRegularFile(releasesPath, "Squirrel RELEASES", MAX_MANIFEST_BYTES);
  const packageEvidence = await hashRegularFile(
    fullPackagePath,
    "Squirrel full package",
    MAX_MAKER_CONTAINER_BYTES,
    ["sha1", "sha256"],
  );
  const release = parseSquirrelReleaseRecord(releaseBytes, options.fullPackageFileName);
  if (release.size !== packageEvidence.length || release.sha1 !== packageEvidence.hashes.sha1) {
    throw new Error("Squirrel RELEASES SHA-1 or size does not match the emitted full package.");
  }

  const setupPe = verifyInvariantPeOrigin(
    setupBytes,
    inputs.buffers.get("setupBootstrap"),
    "Emitted Setup.exe",
  );
  const setupResources = extractSetupArchive(setupBytes, inputs.buffers.get("setupBootstrap"));
  const setupEntries = await inspectSetupArchive(setupResources.archive, {
    names: ["background.gif", options.fullPackageFileName, "RELEASES", "Update.exe"],
    fullPackageFileName: options.fullPackageFileName,
    fullPackagePath,
    buffers: new Map([
      ["background.gif", inputs.buffers.get("installSpinner")],
      ["RELEASES", releaseBytes],
      ["Update.exe", inputs.buffers.get("squirrelExecutable")],
    ]),
  });
  const nupkgExecutables = await inspectNupkgExecutables(
    fullPackagePath,
    options.applicationExecutableName,
    inputs.buffers,
  );
  const evidence = {
    schemaVersion: 2,
    status: "DRAFT — NOT FOR PUBLIC RELEASE",
    verifier: "owncontext-squirrel-maker-provenance-v2",
    approvedInput: {
      manifestSha256: inputs.manifestSha256,
      package: inputs.package,
      packageTree: inputs.packageTree,
      files: inputs.files,
    },
    makerOutput: {
      files: expectedNames,
      setup: {
        name: options.setupFileName,
        length: setupBytes.length,
        sha256: sha256(setupBytes),
        pe: setupPe,
        resourceLayout: setupResources.layout,
        embeddedZip: setupEntries,
      },
      fullPackage: {
        name: options.fullPackageFileName,
        length: packageEvidence.length,
        sha1: packageEvidence.hashes.sha1,
        sha256: packageEvidence.hashes.sha256,
      },
      releases: {
        name: "RELEASES",
        length: releaseBytes.length,
        sha256: sha256(releaseBytes),
        record: release,
      },
      nupkgMakerExecutables: nupkgExecutables,
    },
    boundary: {
      proves: "Every installed electron-winstaller regular file except the two declared mutable non-input logs is pinned; fixed PE regions match approved inputs, allowed PE layout changes are derived, resource semantics and padding are constrained, Setup ZIP local and central metadata agree with recomputed CRC-32, embedded bytes match the inspected package, and NuGet product XML is pinned or canonicalized.",
      doesNotProve: "The nupkg raw local-header versus central-directory equivalence, parser-differential safety, excluded log contents, root-hoisted build dependency bytes, build-host safety, bit-for-bit reproducibility, license sufficiency, signing, clean-machine lifecycle, or public-release approval.",
    },
  };
  if (options.evidencePath) {
    await writeSquirrelMakerEvidenceAtomically(options.evidencePath, options.evidenceRoot, evidence);
  }
  return evidence;
}
