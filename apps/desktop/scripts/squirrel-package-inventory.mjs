const SHA256 = /^[0-9a-f]{64}$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const CORE_PROPERTIES =
  /^package\/services\/metadata\/core-properties\/[0-9a-f]{32}\.psmdcp$/u;

function requireSafeArchivePath(value, directory, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.startsWith("/") ||
    WINDOWS_DRIVE.test(value)
  ) {
    throw new Error(`${label} has an unsafe archive path: ${String(value)}`);
  }

  if (directory !== value.endsWith("/")) {
    throw new Error(`${label} has inconsistent directory metadata: ${value}`);
  }

  const path = directory ? value.slice(0, -1) : value;
  if (
    path.length === 0 ||
    path.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${label} has an unsafe archive path: ${value}`);
  }
  return path;
}

function requireFileEvidence(file, label) {
  if (
    !Number.isSafeInteger(file.length) ||
    file.length < 0 ||
    typeof file.sha256 !== "string" ||
    !SHA256.test(file.sha256)
  ) {
    throw new Error(`${label} has invalid size or SHA-256 evidence.`);
  }
}

function folded(value) {
  return value.toLocaleLowerCase("en-US");
}

function ancestors(path) {
  const segments = path.split("/");
  const result = [];
  for (let index = 1; index < segments.length; index += 1) {
    result.push(`${segments.slice(0, index).join("/")}/`);
  }
  return result;
}

/**
 * Prove that the Squirrel full package contains the complete verified
 * application payload byte-for-byte, with only an explicit maker layer and
 * NuGet metadata outside that mapping.
 */
export function verifySquirrelPackageInventory({
  payloadFiles,
  nupkgEntries,
  packageName,
  applicationExecutableName,
}) {
  if (!Array.isArray(payloadFiles) || payloadFiles.length === 0) {
    throw new Error("The verified application payload inventory is empty.");
  }
  if (!Array.isArray(nupkgEntries) || nupkgEntries.length === 0) {
    throw new Error("The Squirrel package inventory is empty.");
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(packageName)) {
    throw new Error("The Squirrel package name is unsafe.");
  }
  if (!/^[A-Za-z0-9._-]+\.exe$/u.test(applicationExecutableName)) {
    throw new Error("The application executable name is unsafe.");
  }

  const entries = new Map();
  for (const entry of nupkgEntries) {
    if (!entry || typeof entry !== "object" || typeof entry.directory !== "boolean") {
      throw new Error("The Squirrel package inventory contains a malformed entry.");
    }
    const path = requireSafeArchivePath(
      entry.name,
      entry.directory,
      "Squirrel package entry",
    );
    requireFileEvidence(entry, `Squirrel package entry ${entry.name}`);
    if (entry.directory && entry.length !== 0) {
      throw new Error(`Squirrel package directory is not empty: ${entry.name}`);
    }
    const key = folded(entry.name);
    if (entries.has(key)) {
      throw new Error(`Squirrel package contains a case-folded duplicate: ${entry.name}`);
    }
    entries.set(key, { ...entry, path });
  }

  const accountedFiles = new Set();
  const expectedPayloadPaths = new Set();
  for (const payloadFile of payloadFiles) {
    if (!payloadFile || typeof payloadFile !== "object") {
      throw new Error("The verified payload inventory contains a malformed entry.");
    }
    const relativePath = requireSafeArchivePath(
      payloadFile.relativePath,
      false,
      "Verified payload entry",
    );
    requireFileEvidence(payloadFile, `Verified payload entry ${relativePath}`);
    const expectedName = `lib/net45/${relativePath}`;
    const expectedKey = folded(expectedName);
    if (expectedPayloadPaths.has(expectedKey)) {
      throw new Error(`Verified payload contains a case-folded duplicate: ${relativePath}`);
    }
    expectedPayloadPaths.add(expectedKey);

    const packaged = entries.get(expectedKey);
    if (!packaged || packaged.directory) {
      throw new Error(`Squirrel package is missing verified payload file: ${relativePath}`);
    }
    if (packaged.name !== expectedName) {
      throw new Error(`Squirrel package changed payload path casing: ${relativePath}`);
    }
    if (
      packaged.length !== payloadFile.length ||
      packaged.sha256 !== payloadFile.sha256
    ) {
      throw new Error(`Squirrel package changed verified payload bytes: ${relativePath}`);
    }
    accountedFiles.add(expectedKey);
  }

  const executableStem = applicationExecutableName.slice(0, -4);
  const makerAddedNames = [
    "lib/net45/squirrel.exe",
    `lib/net45/${executableStem}_ExecutionStub.exe`,
  ];
  for (const name of makerAddedNames) {
    const entry = entries.get(folded(name));
    if (!entry || entry.directory || entry.name !== name || entry.length === 0) {
      throw new Error(`Squirrel package is missing required maker file: ${name}`);
    }
    if (expectedPayloadPaths.has(folded(name))) {
      throw new Error(`Maker file collides with the verified payload: ${name}`);
    }
    accountedFiles.add(folded(name));
  }

  const metadataNames = [
    `${packageName}.nuspec`,
    "[Content_Types].xml",
    "_rels/.rels",
  ];
  for (const name of metadataNames) {
    const entry = entries.get(folded(name));
    if (!entry || entry.directory || entry.name !== name || entry.length === 0) {
      throw new Error(`Squirrel package is missing required NuGet metadata: ${name}`);
    }
    accountedFiles.add(folded(name));
  }

  const coreProperties = [...entries.values()].filter((entry) =>
    !entry.directory && CORE_PROPERTIES.test(entry.name)
  );
  if (coreProperties.length !== 1) {
    throw new Error("Squirrel package must contain exactly one NuGet core-properties file.");
  }
  accountedFiles.add(folded(coreProperties[0].name));

  for (const entry of entries.values()) {
    if (!entry.directory && !accountedFiles.has(folded(entry.name))) {
      throw new Error(`Squirrel package contains an unexpected file: ${entry.name}`);
    }
  }

  const allowedDirectories = new Set();
  for (const entry of entries.values()) {
    if (!entry.directory && accountedFiles.has(folded(entry.name))) {
      for (const ancestor of ancestors(entry.name)) {
        allowedDirectories.add(folded(ancestor));
      }
    }
  }
  for (const entry of entries.values()) {
    if (entry.directory && !allowedDirectories.has(folded(entry.name))) {
      throw new Error(`Squirrel package contains an unexpected directory: ${entry.name}`);
    }
  }

  return {
    payloadFileCount: payloadFiles.length,
    makerAddedFiles: makerAddedNames,
    metadataFiles: [...metadataNames, coreProperties[0].name],
  };
}
