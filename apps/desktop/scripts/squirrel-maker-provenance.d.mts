export interface PinnedMakerInputFile {
  role: string;
  path: string;
  length: number;
  sha256: string;
}

export interface PinnedMakerInputsEvidence {
  manifestSha256: string;
  package: {
    name: string;
    version: string;
    license: string;
  };
  packageTree: PackageTreeEvidence;
  files: PinnedMakerInputFile[];
}

export interface PackageTreeEntry {
  path: string;
  length: number;
  sha256: string;
}

export interface PackageTreeEvidence {
  fileCount: number;
  totalBytes: number;
  sha256: string;
  excludedMutableFiles: string[];
}

export interface PeInvariantSectionEvidence {
  name: string;
  length: number;
  sha256: string;
  virtualSize: number;
  characteristics: number;
}

export interface PeOriginEvidence {
  machine: number;
  addressOfEntryPoint: number;
  subsystem: number;
  canonicalSha256: string;
  layout: {
    fileAlignment: number;
    sectionAlignment: number;
    resourceVirtualSize: number;
    resourceRawSize: number;
  };
  resourcePadding: {
    length: number;
    mode: string;
  };
  invariantSections: PeInvariantSectionEvidence[];
}

export interface ResourceLayoutEvidence {
  directoryCount: number;
  dataEntryCount: number;
  gapModes: string[];
}

export interface SetupArchiveInventoryEntry {
  name: string;
  length: number;
  directory: boolean;
  compressionMethod: number;
  generalPurposeBitFlag: number;
  sha256?: string;
}

export interface SquirrelReleaseRecord {
  sha1: string;
  fileName: string;
  size: number;
}

export interface SquirrelMakerProvenanceEvidence {
  schemaVersion: 2;
  status: string;
  verifier: string;
  approvedInput: PinnedMakerInputsEvidence;
  makerOutput: {
    product: {
      executableName: string;
      squirrelName: string;
      version: string;
      productName: string;
      description: string;
      copyright: string;
    };
    files: string[];
    setup: {
      name: string;
      length: number;
      sha256: string;
      pe: PeOriginEvidence;
      resourceLayout: ResourceLayoutEvidence;
      versionResource: {
        length: number;
        sha256: string;
        transform: "profile-bound-version-resource";
      };
      embeddedZip: Array<{
        name: string;
        length: number;
        compressedLength: number;
        sha256: string;
        crc32: string;
        dosDate: number;
        dosTime: number;
      }>;
    };
    fullPackage: {
      name: string;
      length: number;
      sha1: string;
      sha256: string;
    };
    releases: {
      name: "RELEASES";
      length: number;
      sha256: string;
      record: SquirrelReleaseRecord;
    };
    nupkgMakerExecutables: {
      squirrel: { name: string; length: number; sha256: string };
      applicationResourceSource: { name: string; length: number; sha256: string };
      executionStub: {
        name: string;
        length: number;
        sha256: string;
        pe: PeOriginEvidence;
        resources: {
          source: "packaged-application-executable";
          entryCount: number;
          semanticSha256: string;
          layout: ResourceLayoutEvidence;
        };
      };
      nugetMetadata: Array<{
        name: string;
        length: number;
        sha256: string;
        transform: string;
      }>;
    };
  };
  boundary: {
    proves: string;
    doesNotProve: string;
  };
}

export function verifyPinnedSquirrelMakerInputs(options: {
  manifestPath: string;
  electronWinstallerDirectory: string;
}): Promise<PinnedMakerInputsEvidence>;

export function verifyPackageTreeInventory(
  entries: PackageTreeEntry[],
  expected: PackageTreeEvidence,
): PackageTreeEvidence;

export function verifyPinnedNugetProductMetadata(
  name: string,
  bytes: ArrayBuffer | ArrayBufferView,
): {
  name: string;
  length: number;
  sha256: string;
  transform: "pinned-bytes";
};

export function verifyInvariantPeOrigin(
  actualBytes: ArrayBuffer | ArrayBufferView,
  approvedBytes: ArrayBuffer | ArrayBufferView,
  label?: string,
): PeOriginEvidence;

export function parseSquirrelReleaseRecord(
  contents: string | ArrayBuffer | ArrayBufferView,
  expectedPackageFileName: string,
): SquirrelReleaseRecord;

export function verifySetupArchiveInventory(
  entries: SetupArchiveInventoryEntry[],
  expectedNames: string[],
): string[];

export function verifyStrictSetupZipContainer(
  archiveBytes: ArrayBuffer | ArrayBufferView,
  expectedNames: string[],
): {
  length: number;
  centralOffset: number;
  centralSize: number;
  entries: Array<{
    name: string;
    dataOffset: number;
    compressedLength: number;
    uncompressedLength: number;
    crc32: string;
    dosDate: number;
    dosTime: number;
  }>;
};

export function verifyDeflateEntryFullyConsumed(
  compressedBytes: ArrayBuffer | ArrayBufferView,
  expected: { uncompressedLength: number; crc32: string },
): Promise<{ compressedLength: number; uncompressedLength: number; crc32: string }>;

export function writeSquirrelMakerEvidenceAtomically(
  evidencePath: string,
  evidenceRoot: string,
  evidence: unknown,
): Promise<void>;

export function verifySquirrelMakerProvenance(options: {
  makerDirectory: string;
  electronWinstallerDirectory: string;
  manifestPath: string;
  setupFileName: string;
  fullPackageFileName: string;
  applicationExecutableName: string;
  product: {
    executableName: string;
    squirrelName: string;
    version: string;
    productName: string;
    description: string;
    copyright: string;
  };
  evidenceRoot?: string;
  evidencePath?: string;
}): Promise<SquirrelMakerProvenanceEvidence>;
