export interface PayloadInventoryFile {
  relativePath: string;
  length: number;
  sha256: string;
}

export interface NupkgInventoryEntry {
  name: string;
  length: number;
  sha256: string;
  directory: boolean;
}

export interface SquirrelPackageInventoryResult {
  payloadFileCount: number;
  makerAddedFiles: string[];
  metadataFiles: string[];
}

export function verifySquirrelPackageInventory(input: {
  payloadFiles: PayloadInventoryFile[];
  nupkgEntries: NupkgInventoryEntry[];
  packageName: string;
  applicationExecutableName: string;
}): SquirrelPackageInventoryResult;
