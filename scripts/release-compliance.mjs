#!/usr/bin/env node

import asar from "@electron/asar";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TOOL_VERSION = "1";
const NOTICE_NAME = "THIRD_PARTY_NOTICES.txt";
const SBOM_NAME = "SBOM.spdx.json";
const CHECKSUM_NAME = "SHA256SUMS";
const GENERATED_NAMES = new Set([NOTICE_NAME, SBOM_NAME, CHECKSUM_NAME]);
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[.\-_].*)?$/iu;
const MAX_ASAR_ENTRIES = 100_000;
const MAX_ASAR_HEADER_BYTES = 67_108_864;
const MAX_ASAR_PATH_CHARS = 4_096;
const MAX_PACKAGE_MANIFEST_BYTES = 1_048_576;
const UNRESOLVED_LICENSES = new Set([
  "",
  "NOASSERTION",
  "NONE",
  "UNLICENSED",
]);

export class ComplianceError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "ComplianceError";
    this.code = code;
    this.details = [...details];
  }
}

export async function generateCompliance({
  artifactPath,
  projectRoot = process.cwd(),
  outputPath,
  draft = false,
} = {}) {
  const context = await createContext({ artifactPath, projectRoot, outputPath, draft });
  const payloadFiles = await inspectArtifact(context);
  const components = await collectRuntimeComponents(context);
  const notice = await renderThirdPartyNotices(context, components);
  const sbom = renderSpdx(context, components, payloadFiles);

  await mkdir(context.outputRoot, { recursive: true });
  await assertGeneratedDirectoryContainsOnlyKnownFiles(context.outputRoot);
  await writeFile(resolve(context.outputRoot, NOTICE_NAME), notice, "utf8");
  await writeFile(
    resolve(context.outputRoot, SBOM_NAME),
    `${JSON.stringify(sbom, null, 2)}\n`,
    "utf8",
  );

  const checksumFiles = await inventoryFiles(context.artifactRoot, {
    excludeRelativePaths: new Set([context.checksumRelativePath]),
  });
  const checksumText = checksumFiles
    .map((file) => `${file.sha256}  ${file.relativePath}`)
    .join("\n");
  await writeFile(
    resolve(context.outputRoot, CHECKSUM_NAME),
    checksumText.length > 0 ? `${checksumText}\n` : "",
    "utf8",
  );

  return {
    artifactRoot: context.artifactRoot,
    outputRoot: context.outputRoot,
    draft: context.draft,
    componentCount: components.length,
    payloadFileCount: payloadFiles.length,
    checksumFileCount: checksumFiles.length,
    files: {
      notices: resolve(context.outputRoot, NOTICE_NAME),
      sbom: resolve(context.outputRoot, SBOM_NAME),
      checksums: resolve(context.outputRoot, CHECKSUM_NAME),
    },
  };
}

export async function verifyCompliance({
  artifactPath,
  projectRoot = process.cwd(),
  outputPath,
  draft = false,
} = {}) {
  const context = await createContext({ artifactPath, projectRoot, outputPath, draft });
  const payloadFiles = await inspectArtifact(context);
  const components = await collectRuntimeComponents(context);
  const noticePath = resolve(context.outputRoot, NOTICE_NAME);
  const sbomPath = resolve(context.outputRoot, SBOM_NAME);
  const checksumPath = resolve(context.outputRoot, CHECKSUM_NAME);

  for (const requiredPath of [noticePath, sbomPath, checksumPath]) {
    if (!(await isRegularFile(requiredPath))) {
      throw new ComplianceError(
        "COMPLIANCE_FILE_MISSING",
        `Required generated compliance file is missing: ${requiredPath}`,
      );
    }
  }

  const expectedNotice = await renderThirdPartyNotices(context, components);
  const actualNotice = await readFile(noticePath, "utf8");
  if (actualNotice !== expectedNotice) {
    throw new ComplianceError(
      "NOTICES_OUT_OF_DATE",
      `${NOTICE_NAME} does not match the locked production component set`,
    );
  }

  const sbom = await readJson(sbomPath, "SPDX SBOM");
  verifySpdx(sbom, context, components, payloadFiles);
  await verifyChecksums(context, checksumPath);

  return {
    artifactRoot: context.artifactRoot,
    outputRoot: context.outputRoot,
    draft: context.draft,
    componentCount: components.length,
    payloadFileCount: payloadFiles.length,
  };
}

async function createContext({ artifactPath, projectRoot, outputPath, draft }) {
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    throw new ComplianceError(
      "ARTIFACT_REQUIRED",
      "An unpacked artifact directory is required (--artifact <directory>)",
    );
  }
  const resolvedProjectRoot = await requireRealDirectory(projectRoot, "project root");
  const artifactRoot = await requireRealDirectory(artifactPath, "artifact root");
  const requestedOutput = resolve(outputPath ?? resolve(artifactRoot, "compliance"));
  if (!isStrictDescendant(artifactRoot, requestedOutput)) {
    throw new ComplianceError(
      "OUTPUT_OUTSIDE_ARTIFACT",
      "Compliance output must be a proper subdirectory of the artifact",
    );
  }
  await assertSafeOutputPath(artifactRoot, requestedOutput);
  const outputRelativePath = toPosix(relative(artifactRoot, requestedOutput));
  const packageJson = await readJson(
    resolve(resolvedProjectRoot, "package.json"),
    "root package.json",
  );
  const lock = await readJson(
    resolve(resolvedProjectRoot, "package-lock.json"),
    "package-lock.json",
  );
  if (lock.lockfileVersion !== 3 || !isObject(lock.packages)) {
    throw new ComplianceError(
      "LOCKFILE_UNSUPPORTED",
      "Release compliance requires an npm lockfileVersion 3 packages map",
    );
  }

  const licenseState = await inspectProjectLicense(resolvedProjectRoot, packageJson, lock);
  if (!draft && licenseState.issues.length > 0) {
    throw new ComplianceError(
      "PROJECT_LICENSE_UNRESOLVED",
      "Public release remains blocked until the project license is selected",
      licenseState.issues,
    );
  }

  const electronDist = resolve(resolvedProjectRoot, "node_modules", "electron", "dist");
  const electronPackage = await readJson(
    resolve(resolvedProjectRoot, "node_modules", "electron", "package.json"),
    "installed Electron package.json",
  );
  const electronLicense = resolve(electronDist, "LICENSE");
  const chromiumLicenses = resolve(electronDist, "LICENSES.chromium.html");
  const electronFfmpeg = resolve(electronDist, "ffmpeg.dll");
  if (!(await isRegularFile(electronLicense)) || !(await isRegularFile(chromiumLicenses))) {
    throw new ComplianceError(
      "ELECTRON_LICENSE_SOURCE_MISSING",
      "Installed Electron LICENSE and LICENSES.chromium.html are required as release evidence",
    );
  }

  return {
    projectRoot: resolvedProjectRoot,
    artifactRoot,
    outputRoot: requestedOutput,
    outputRelativePath,
    checksumRelativePath: `${outputRelativePath}/${CHECKSUM_NAME}`,
    packageJson,
    lock,
    draft: Boolean(draft),
    projectLicense: licenseState.license,
    projectLicenseIssues: licenseState.issues,
    electron: {
      name: String(electronPackage.name ?? "electron"),
      version: String(electronPackage.version ?? "UNKNOWN"),
      license: normalizeLicense(electronPackage.license),
      packageRoot: resolve(resolvedProjectRoot, "node_modules", "electron"),
      licensePath: electronLicense,
      chromiumLicensePath: chromiumLicenses,
      expectedLicenseHash: await hashFile(electronLicense),
      expectedChromiumHash: await hashFile(chromiumLicenses),
      expectedFfmpegHash: (await isRegularFile(electronFfmpeg))
        ? await hashFile(electronFfmpeg)
        : null,
    },
  };
}

async function inspectProjectLicense(projectRoot, rootPackage, lock) {
  const issues = [];
  const rootLicense = normalizeLicense(rootPackage.license);
  if (isUnresolvedLicense(rootLicense)) {
    issues.push("Root package.json has no selected SPDX license expression");
  }

  const licensePath = resolve(projectRoot, "LICENSE");
  if (!(await isRegularFile(licensePath))) {
    issues.push("The repository has no top-level LICENSE file");
  } else if ((await readFile(licensePath)).byteLength === 0) {
    issues.push("The top-level LICENSE file is empty");
  }

  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (
      lockPath === "" ||
      lockPath.startsWith("node_modules/") ||
      !isObject(metadata) ||
      typeof metadata.name !== "string" ||
      !metadata.name.startsWith("@owncontext/")
    ) {
      continue;
    }
    const workspacePackage = await readJson(
      resolve(projectRoot, lockPath, "package.json"),
      `${lockPath}/package.json`,
    );
    if (isUnresolvedLicense(normalizeLicense(workspacePackage.license))) {
      issues.push(`${lockPath}/package.json has no selected SPDX license expression`);
    }
  }
  return {
    license: isUnresolvedLicense(rootLicense) ? "NOASSERTION" : rootLicense,
    issues,
  };
}

async function inspectArtifact(context) {
  const outputPrefix = `${context.outputRelativePath}/`;
  const payloadFiles = await inventoryFiles(context.artifactRoot, {
    exclude: (relativePath) =>
      relativePath === context.outputRelativePath || relativePath.startsWith(outputPrefix),
  });
  if (payloadFiles.length === 0) {
    throw new ComplianceError("ARTIFACT_EMPTY", "The artifact contains no payload files");
  }

  const archivedFiles = await inspectAsarArchives(payloadFiles);

  const electronLicense = payloadFiles.find(
    (file) =>
      LICENSE_FILE_PATTERN.test(basename(file.relativePath)) &&
      file.sha256 === context.electron.expectedLicenseHash,
  );
  const chromiumLicense = payloadFiles.find(
    (file) =>
      basename(file.relativePath).toLocaleLowerCase("en-US") ===
        "licenses.chromium.html" &&
      file.sha256 === context.electron.expectedChromiumHash,
  );
  if (!electronLicense || !chromiumLicense) {
    const missing = [];
    if (!electronLicense) missing.push("Electron LICENSE (exact installed content)");
    if (!chromiumLicense) {
      missing.push("Electron LICENSES.chromium.html (exact installed content)");
    }
    throw new ComplianceError(
      "ELECTRON_LICENSE_NOT_PRESERVED",
      "The unpacked artifact does not preserve required Electron license evidence",
      missing,
    );
  }

  const ffmpegFiles = payloadFiles.filter(
    (file) => basename(file.relativePath).toLocaleLowerCase("en-US") === "ffmpeg.dll",
  );
  if (
    ffmpegFiles.length > 0 &&
    (!context.electron.expectedFfmpegHash ||
      ffmpegFiles.some((file) => file.sha256 !== context.electron.expectedFfmpegHash))
  ) {
    throw new ComplianceError(
      "ELECTRON_FFMPEG_VARIANT_UNRESOLVED",
      "The artifact contains an ffmpeg.dll that does not match the installed Electron binary",
      ffmpegFiles.map((file) => file.relativePath),
    );
  }

  await assertNoDevelopmentDependencies(context, [...payloadFiles, ...archivedFiles]);
  context.electron.artifactLicenseRelativePath = electronLicense.relativePath;
  context.electron.artifactChromiumRelativePath = chromiumLicense.relativePath;
  context.electron.artifactFfmpegRelativePath = ffmpegFiles.find(
    (file) => file.sha256 === context.electron.expectedFfmpegHash,
  )?.relativePath;
  return payloadFiles;
}

async function inspectAsarArchives(payloadFiles) {
  const archivedFiles = [];
  const archives = payloadFiles.filter(
    (file) => file.relativePath.toLocaleLowerCase("en-US").endsWith(".asar"),
  );
  for (const archive of archives) {
    try {
      await assertBoundedAsarHeader(archive);
      asar.uncache(archive.absolutePath);
      const paths = asar.listPackage(archive.absolutePath, { isPack: false });
      if (paths.length > MAX_ASAR_ENTRIES) {
        throw new ComplianceError(
          "ASAR_ENTRY_LIMIT_EXCEEDED",
          `ASAR contains more than ${MAX_ASAR_ENTRIES} entries: ${archive.relativePath}`,
        );
      }
      const seen = new Set();
      for (const archivePath of paths) {
        const normalizedPath = normalizeAsarPath(archivePath, archive.relativePath);
        const comparisonPath = normalizedPath.toLocaleLowerCase("en-US");
        if (seen.has(comparisonPath)) {
          throw new ComplianceError(
            "ASAR_PATH_UNSAFE",
            `ASAR contains duplicate case-insensitive paths: ${archive.relativePath}!/${normalizedPath}`,
          );
        }
        seen.add(comparisonPath);
        const metadata = asar.statFile(archive.absolutePath, fromPosix(normalizedPath), false);
        if ("link" in metadata) {
          throw new ComplianceError(
            "ASAR_LINK_UNSUPPORTED",
            `ASAR contains a link: ${archive.relativePath}!/${normalizedPath}`,
          );
        }
        if ("files" in metadata) continue;

        const entry = { relativePath: `${archive.relativePath}!/${normalizedPath}` };
        if (basename(normalizedPath).toLocaleLowerCase("en-US") === "package.json") {
          if (metadata.size > MAX_PACKAGE_MANIFEST_BYTES) {
            throw new ComplianceError(
              "ASAR_MANIFEST_INVALID",
              `ASAR package manifest exceeds ${MAX_PACKAGE_MANIFEST_BYTES} bytes: ${entry.relativePath}`,
            );
          }
          const manifestBuffer = asar.extractFile(
            archive.absolutePath,
            fromPosix(normalizedPath),
            false,
          );
          const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBuffer);
          const manifest = JSON.parse(manifestText);
          if (!isObject(manifest)) throw new TypeError("JSON root must be an object");
          entry.manifest = manifest;
        }
        archivedFiles.push(entry);
      }
    } catch (error) {
      if (error instanceof ComplianceError) throw error;
      throw new ComplianceError(
        "ASAR_INSPECTION_FAILED",
        `Cannot inspect ASAR archive: ${archive.relativePath}`,
        [errorMessage(error)],
      );
    } finally {
      asar.uncache(archive.absolutePath);
    }
  }
  return archivedFiles;
}

async function assertBoundedAsarHeader(archive) {
  const header = Buffer.alloc(8);
  const handle = await open(archive.absolutePath, "r");
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error("ASAR header is truncated");
  } finally {
    await handle.close();
  }
  const headerBytes = header.readUInt32LE(4);
  if (
    header.readUInt32LE(0) !== 4 ||
    headerBytes < 8 ||
    headerBytes > MAX_ASAR_HEADER_BYTES ||
    headerBytes > archive.size - 8
  ) {
    throw new ComplianceError(
      "ASAR_HEADER_UNSAFE",
      `ASAR header is invalid or exceeds ${MAX_ASAR_HEADER_BYTES} bytes: ${archive.relativePath}`,
    );
  }
}

function normalizeAsarPath(archivePath, archiveRelativePath) {
  if (typeof archivePath !== "string" || archivePath.length > MAX_ASAR_PATH_CHARS) {
    throw new ComplianceError(
      "ASAR_PATH_UNSAFE",
      `ASAR path is empty or too long: ${archiveRelativePath}`,
    );
  }
  const normalized = archivePath.replace(/^[/\\]+/u, "").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    /^[/\\]{2}/u.test(archivePath) ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || segment.includes(":"),
    )
  ) {
    throw new ComplianceError(
      "ASAR_PATH_UNSAFE",
      `ASAR contains an unsafe path: ${archiveRelativePath}!/${normalized}`,
    );
  }
  return normalized;
}

async function assertNoDevelopmentDependencies(context, payloadFiles) {
  const productionPairs = new Set();
  const devEntries = [];
  for (const [lockPath, metadata] of Object.entries(context.lock.packages)) {
    if (!lockPath.startsWith("node_modules/") || !isObject(metadata)) continue;
    const identity = await packageIdentity(context.projectRoot, lockPath, metadata);
    if (!identity) continue;
    const pair = `${identity.name}@${identity.version}`;
    if (metadata.dev === true) devEntries.push({ ...identity, pair });
    else productionPairs.add(pair);
  }
  const devOnlyPairs = new Set(
    devEntries.map((entry) => entry.pair).filter((pair) => !productionPairs.has(pair)),
  );
  const productionNames = new Set(
    [...productionPairs].map((pair) => pair.slice(0, pair.lastIndexOf("@"))),
  );
  const devOnlyNames = new Set(
    devEntries
      .map((entry) => entry.name)
      .filter((name) => !productionNames.has(name)),
  );
  const violations = [];

  for (const file of payloadFiles) {
    const lowerPath = `/${file.relativePath.toLocaleLowerCase("en-US")}`;
    for (const name of devOnlyNames) {
      const marker = `/node_modules/${name.toLocaleLowerCase("en-US")}/`;
      if (lowerPath.includes(marker)) {
        violations.push(`${file.relativePath}: path contains dev-only package ${name}`);
        break;
      }
    }
    if (basename(file.relativePath).toLocaleLowerCase("en-US") !== "package.json") {
      continue;
    }
    const manifest = file.manifest ?? await readJson(
      resolve(context.artifactRoot, fromPosix(file.relativePath)),
      `artifact manifest ${file.relativePath}`,
    );
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
    const pair = `${manifest.name}@${manifest.version}`;
    if (devOnlyPairs.has(pair)) {
      violations.push(`${file.relativePath}: ${pair} is dev-only in package-lock.json`);
    }
  }
  if (violations.length > 0) {
    throw new ComplianceError(
      "DEV_DEPENDENCY_IN_ARTIFACT",
      "The artifact contains development-only dependencies",
      [...new Set(violations)].sort(),
    );
  }
}

async function collectRuntimeComponents(context) {
  const { projectRoot, lock } = context;
  const unique = new Map();
  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (
      !lockPath.startsWith("node_modules/") ||
      !isObject(metadata) ||
      metadata.dev === true
    ) {
      continue;
    }
    const identity = await packageIdentity(projectRoot, lockPath, metadata);
    if (!identity || identity.name.startsWith("@owncontext/")) continue;
    const key = `${identity.name}@${identity.version}`;
    if (unique.has(key)) continue;
    const packageRoot = resolve(projectRoot, fromPosix(lockPath));
    const manifest = await readJson(resolve(packageRoot, "package.json"), `${key} package.json`);
    const license = normalizeLicense(manifest.license ?? metadata.license);
    if (isUnresolvedLicense(license)) {
      throw new ComplianceError(
        "DEPENDENCY_LICENSE_UNRESOLVED",
        `${key} has no declared license expression`,
      );
    }
    const licenseFiles = await readImmediateLicenseFiles(packageRoot);
    if (licenseFiles.length === 0) {
      throw new ComplianceError(
        "DEPENDENCY_LICENSE_TEXT_MISSING",
        `${key} has no installed LICENSE/COPYING/NOTICE text`,
      );
    }
    unique.set(key, {
      name: identity.name,
      version: identity.version,
      license,
      licenseFiles,
      purl: `pkg:npm/${encodePackageForPurl(identity.name)}@${encodeURIComponent(identity.version)}`,
    });
  }

  const electronManifest = await readJson(
    resolve(projectRoot, "node_modules", "electron", "package.json"),
    "Electron package.json",
  );
  const electronKey = `electron@${String(electronManifest.version)}`;
  unique.set(electronKey, {
    name: "electron",
    version: String(electronManifest.version),
    license: normalizeLicense(electronManifest.license),
    licenseFiles: await readImmediateLicenseFiles(resolve(projectRoot, "node_modules", "electron")),
    purl: `pkg:npm/electron@${encodeURIComponent(String(electronManifest.version))}`,
  });

  unique.set(`electron-bundled-chromium-components@${context.electron.version}`, {
    name: "electron-bundled-chromium-components",
    version: context.electron.version,
    license: "NOASSERTION",
    licenseFiles: [],
    licenseReference: `Complete bundled notices: ${context.electron.artifactChromiumRelativePath}`,
  });

  if (context.electron.artifactFfmpegRelativePath) {
    unique.set(`electron-bundled-ffmpeg@${context.electron.version}`, {
      name: "electron-bundled-ffmpeg",
      version: context.electron.version,
      license: "LGPL-2.1-or-later",
      concludedLicense: "NOASSERTION",
      licenseFiles: [],
      licenseReference: [
        `Binary: ${context.electron.artifactFfmpegRelativePath}`,
        `Bundled license collection: ${context.electron.artifactChromiumRelativePath}`,
      ].join("; "),
    });
  }

  return [...unique.values()].sort(compareComponents);
}

async function packageIdentity(projectRoot, lockPath, metadata) {
  const packageRoot = resolve(projectRoot, fromPosix(lockPath));
  if (!(await isRegularFile(resolve(packageRoot, "package.json")))) {
    if (metadata.optional === true) return null;
    throw new ComplianceError(
      "LOCKED_PACKAGE_NOT_INSTALLED",
      `Locked package is not installed: ${lockPath}`,
    );
  }
  const manifest = await readJson(resolve(packageRoot, "package.json"), `${lockPath}/package.json`);
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new ComplianceError(
      "PACKAGE_IDENTITY_MISSING",
      `Installed package lacks name/version: ${lockPath}`,
    );
  }
  if (typeof metadata.version === "string" && metadata.version !== manifest.version) {
    throw new ComplianceError(
      "LOCK_INSTALL_MISMATCH",
      `${lockPath} is ${manifest.version}, lockfile requires ${metadata.version}`,
    );
  }
  return { name: manifest.name, version: manifest.version };
}

async function readImmediateLicenseFiles(packageRoot) {
  const entries = [];
  const directory = await opendir(packageRoot);
  for await (const entry of directory) {
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) entries.push(entry.name);
  }
  entries.sort(compareText);
  return Promise.all(
    entries.map(async (name) => ({ name, text: await readFile(resolve(packageRoot, name), "utf8") })),
  );
}

async function renderThirdPartyNotices(context, components) {
  const lines = [
    "OwnContext third-party notices",
    "================================",
    "",
    "Generated from the locked production dependency graph and the unpacked artifact.",
    "This file does not license OwnContext itself and does not lift LICENSE-STATUS.md.",
    `Project license: ${context.projectLicense}`,
    `Mode: ${context.draft ? "DRAFT — NOT FOR PUBLIC RELEASE" : "RELEASE"}`,
    "",
    `Electron's Chromium notices are preserved separately at: ${context.electron.artifactChromiumRelativePath}`,
    "",
  ];
  for (const component of components) {
    lines.push(
      "------------------------------------------------------------------------",
      `${component.name}@${component.version}`,
      `Declared license: ${component.license}`,
      "",
    );
    for (const licenseFile of component.licenseFiles) {
      lines.push(`--- ${licenseFile.name} ---`, licenseFile.text.trimEnd(), "");
    }
    if (component.licenseReference) {
      lines.push(component.licenseReference, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSpdx(context, components, payloadFiles) {
  const packageName = String(context.packageJson.name ?? "owncontext");
  const packageVersion = String(context.packageJson.version ?? "0.0.0");
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        files: payloadFiles.map(({ relativePath, sha256, size }) => ({
          relativePath,
          sha256,
          size,
        })),
        components: components.map(({ name, version, license }) => ({ name, version, license })),
      }),
    )
    .digest("hex");
  const rootId = "SPDXRef-Package-owncontext";
  const componentPackages = components.map((component) => ({
    name: component.name,
    SPDXID: componentSpdxId(component),
    versionInfo: component.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: component.concludedLicense ?? component.license,
    licenseDeclared: component.license,
    copyrightText: "NOASSERTION",
    ...(component.purl
      ? {
          externalRefs: [
            {
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: component.purl,
            },
          ],
        }
      : {}),
  }));
  const files = payloadFiles.map((file) => ({
    fileName: `./${file.relativePath}`,
    SPDXID: fileSpdxId(file.relativePath),
    checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
    licenseConcluded: "NOASSERTION",
    licenseInfoInFiles: ["NOASSERTION"],
    copyrightText: "NOASSERTION",
  }));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${packageName}-${packageVersion}-windows-artifact`,
    documentNamespace: `https://owncontext.dev/spdx/${encodeURIComponent(packageVersion)}/${digest}`,
    creationInfo: {
      created: spdxTimestamp(),
      creators: [`Tool: OwnContext release-compliance/${TOOL_VERSION}`],
    },
    packages: [
      {
        name: packageName,
        SPDXID: rootId,
        versionInfo: packageVersion,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: context.projectLicense,
        licenseDeclared: context.projectLicense,
        copyrightText: "NOASSERTION",
      },
      ...componentPackages,
    ],
    files,
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: rootId,
      },
      ...componentPackages.map((component) => ({
        spdxElementId: rootId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: component.SPDXID,
      })),
      ...files.map((file) => ({
        spdxElementId: rootId,
        relationshipType: "CONTAINS",
        relatedSpdxElement: file.SPDXID,
      })),
    ],
    annotations: context.draft
      ? [
          {
            annotationDate: spdxTimestamp(),
            annotationType: "OTHER",
            annotator: `Tool: OwnContext release-compliance/${TOOL_VERSION}`,
            comment: `DRAFT — NOT FOR PUBLIC RELEASE. ${context.projectLicenseIssues.join("; ")}`,
          },
        ]
      : [],
  };
}

function verifySpdx(sbom, context, components, payloadFiles) {
  if (!isObject(sbom) || sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.packages)) {
    throw new ComplianceError("SBOM_INVALID", "SBOM.spdx.json is not an SPDX 2.3 document");
  }
  const actualComponents = new Set(
    sbom.packages
      .filter((item) => isObject(item) && item.SPDXID !== "SPDXRef-Package-owncontext")
      .map((item) => `${String(item.name)}@${String(item.versionInfo)}|${String(item.licenseDeclared)}`),
  );
  const expectedComponents = new Set(
    components.map((item) => `${item.name}@${item.version}|${item.license}`),
  );
  if (!setsEqual(actualComponents, expectedComponents)) {
    throw new ComplianceError(
      "SBOM_COMPONENT_MISMATCH",
      "SBOM component set does not match the locked production graph",
    );
  }
  if (!Array.isArray(sbom.files)) {
    throw new ComplianceError("SBOM_INVALID", "SBOM has no artifact file inventory");
  }
  const actualFiles = new Map(
    sbom.files
      .filter(isObject)
      .map((item) => [
        String(item.fileName).replace(/^\.\//u, ""),
        Array.isArray(item.checksums) && isObject(item.checksums[0])
          ? String(item.checksums[0].checksumValue)
          : "",
      ]),
  );
  const expectedFiles = new Map(payloadFiles.map((file) => [file.relativePath, file.sha256]));
  if (!mapsEqual(actualFiles, expectedFiles)) {
    throw new ComplianceError(
      "SBOM_FILE_MISMATCH",
      "SBOM file inventory does not match the unpacked artifact payload",
    );
  }
  const rootPackage = sbom.packages.find(
    (item) => isObject(item) && item.SPDXID === "SPDXRef-Package-owncontext",
  );
  if (!rootPackage || rootPackage.licenseDeclared !== context.projectLicense) {
    throw new ComplianceError(
      "SBOM_PROJECT_LICENSE_MISMATCH",
      "SBOM project license does not match current project metadata",
    );
  }

  const expected = renderSpdx(context, components, payloadFiles);
  const created = isObject(sbom.creationInfo) ? sbom.creationInfo.created : undefined;
  if (typeof created !== "string" || !isSpdxTimestamp(created)) {
    throw new ComplianceError("SBOM_INVALID", "SBOM creation timestamp is invalid");
  }
  expected.creationInfo.created = created;
  if (context.draft) {
    const annotationDate = Array.isArray(sbom.annotations) && isObject(sbom.annotations[0])
      ? sbom.annotations[0].annotationDate
      : undefined;
    if (typeof annotationDate !== "string" || !isSpdxTimestamp(annotationDate)) {
      throw new ComplianceError("SBOM_INVALID", "SBOM draft annotation timestamp is invalid");
    }
    expected.annotations[0].annotationDate = annotationDate;
  }
  if (JSON.stringify(sbom) !== JSON.stringify(expected)) {
    throw new ComplianceError(
      "SBOM_CONTENT_MISMATCH",
      "SBOM content does not exactly match the generated artifact evidence",
    );
  }
}

async function verifyChecksums(context, checksumPath) {
  const entries = parseChecksums(await readFile(checksumPath, "utf8"));
  const actualFiles = await inventoryFiles(context.artifactRoot, {
    excludeRelativePaths: new Set([context.checksumRelativePath]),
  });
  const actual = new Map(actualFiles.map((file) => [file.relativePath, file.sha256]));
  if (!mapsEqual(entries, actual)) {
    const details = [];
    for (const [relativePath, expectedHash] of entries) {
      const actualHash = actual.get(relativePath);
      if (!actualHash) details.push(`missing: ${relativePath}`);
      else if (actualHash !== expectedHash) details.push(`changed: ${relativePath}`);
    }
    for (const relativePath of actual.keys()) {
      if (!entries.has(relativePath)) details.push(`unrecorded: ${relativePath}`);
    }
    throw new ComplianceError(
      "CHECKSUM_MISMATCH",
      "Artifact contents do not match SHA256SUMS",
      details.sort(),
    );
  }
}

function parseChecksums(value) {
  const result = new Map();
  for (const line of value.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) {
      throw new ComplianceError("CHECKSUM_FILE_INVALID", `Invalid SHA256SUMS line: ${line}`);
    }
    const relativePath = match[2];
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath === ".." ||
      relativePath.startsWith("../")
    ) {
      throw new ComplianceError(
        "CHECKSUM_FILE_INVALID",
        `Unsafe SHA256SUMS path: ${relativePath}`,
      );
    }
    if (result.has(relativePath)) {
      throw new ComplianceError(
        "CHECKSUM_FILE_INVALID",
        `Duplicate SHA256SUMS path: ${relativePath}`,
      );
    }
    result.set(relativePath, match[1]);
  }
  return result;
}

async function inventoryFiles(root, { exclude, excludeRelativePaths = new Set() } = {}) {
  const files = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = toPosix(relative(root, absolutePath));
      if (exclude?.(relativePath) || excludeRelativePaths.has(relativePath)) continue;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        throw new ComplianceError(
          "ARTIFACT_SYMLINK_UNSUPPORTED",
          `Artifact contains a symbolic link or junction: ${relativePath}`,
        );
      }
      if (entry.name.includes("\n") || entry.name.includes("\r")) {
        throw new ComplianceError(
          "ARTIFACT_PATH_UNSAFE",
          `Artifact path contains a line break: ${relativePath}`,
        );
      }
      if (info.isDirectory()) {
        directories.push(absolutePath);
      } else if (info.isFile()) {
        files.push({
          relativePath,
          absolutePath,
          size: info.size,
          sha256: await hashFile(absolutePath),
        });
      }
    }
  }
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  return files;
}

async function assertGeneratedDirectoryContainsOnlyKnownFiles(outputRoot) {
  try {
    const entries = [];
    const handle = await opendir(outputRoot);
    for await (const entry of handle) entries.push(entry);
    const unexpected = entries
      .filter((entry) => !entry.isFile() || !GENERATED_NAMES.has(entry.name))
      .map((entry) => entry.name);
    if (unexpected.length > 0) {
      throw new ComplianceError(
        "COMPLIANCE_OUTPUT_NOT_CLEAN",
        "Compliance output directory contains unmanaged entries",
        unexpected.sort(),
      );
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  const file = createReadStream(path);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest("hex");
}

async function assertSafeOutputPath(artifactRoot, outputRoot) {
  const segments = relative(artifactRoot, outputRoot).split(sep);
  let current = artifactRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ComplianceError(
          "COMPLIANCE_OUTPUT_UNSAFE",
          `Compliance output path crosses a symlink, junction, or non-directory: ${current}`,
        );
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function requireRealDirectory(path, label) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new ComplianceError("DIRECTORY_REQUIRED", `${label} must be a directory path`);
  }
  const requested = resolve(path);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ComplianceError("DIRECTORY_INVALID", `${label} must be a non-symlink directory`);
  }
  return realpath(requested);
}

async function readJson(path, label) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)) throw new TypeError("JSON root must be an object");
    return value;
  } catch (error) {
    if (error instanceof ComplianceError) throw error;
    throw new ComplianceError("JSON_INVALID", `Cannot read ${label}: ${errorMessage(error)}`);
  }
}

async function isRegularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function normalizeLicense(value) {
  if (typeof value === "string") return value.trim();
  if (isObject(value) && typeof value.type === "string") return value.type.trim();
  return "";
}

function isUnresolvedLicense(value) {
  const normalized = value.trim().toLocaleUpperCase("en-US");
  return (
    UNRESOLVED_LICENSES.has(normalized) ||
    normalized.startsWith("SEE LICENSE") ||
    normalized === "PROPRIETARY"
  );
}

function componentSpdxId(component) {
  const digest = createHash("sha256")
    .update(`${component.name}@${component.version}`)
    .digest("hex")
    .slice(0, 16);
  return `SPDXRef-Package-${sanitizeSpdx(component.name)}-${digest}`;
}

function fileSpdxId(relativePath) {
  return `SPDXRef-File-${createHash("sha256").update(relativePath).digest("hex")}`;
}

function sanitizeSpdx(value) {
  return value.replace(/[^A-Za-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "package";
}

function encodePackageForPurl(name) {
  return name.startsWith("@")
    ? `${encodeURIComponent(name.split("/")[0] ?? "")}/${encodeURIComponent(name.split("/")[1] ?? "")}`
    : encodeURIComponent(name);
}

function isSpdxTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function spdxTimestamp() {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch !== undefined && /^\d+$/u.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1_000).toISOString().replace(/\.000Z$/u, "Z");
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function compareComponents(left, right) {
  return compareText(`${left.name}@${left.version}`, `${right.name}@${right.version}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function fromPosix(value) {
  return value.split("/").join(sep);
}

function isStrictDescendant(parent, child) {
  const difference = relative(parent, child);
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function isErrno(error, code) {
  return isObject(error) && error.code === code;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseCli(argv) {
  const [command, ...tokens] = argv;
  if (command !== "generate" && command !== "verify") return null;
  const options = { command, draft: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--draft") {
      options.draft = true;
      continue;
    }
    if (token === "--artifact" || token === "--project-root" || token === "--output") {
      const value = tokens[index + 1];
      if (!value) throw new ComplianceError("CLI_INVALID", `${token} requires a value`);
      if (token === "--artifact") options.artifactPath = value;
      if (token === "--project-root") options.projectRoot = value;
      if (token === "--output") options.outputPath = value;
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && options.artifactPath === undefined) {
      options.artifactPath = token;
      continue;
    }
    throw new ComplianceError("CLI_INVALID", `Unknown argument: ${token}`);
  }
  return options;
}

async function runCli() {
  const parsed = parseCli(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      "Usage: node scripts/release-compliance.mjs <generate|verify> <artifact-dir> [--output <artifact-subdir>] [--project-root <repo>] [--draft]\n",
    );
    process.exitCode = 2;
    return;
  }
  const operation = parsed.command === "generate" ? generateCompliance : verifyCompliance;
  try {
    const result = await operation(parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof ComplianceError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`- ${detail}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await runCli();
