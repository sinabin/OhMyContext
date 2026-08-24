import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeSqliteDevelopmentStorageProvider,
  openVault,
  type Vault,
  type PlaintextVaultStorageDescriptor,
  type VaultStorageProvider,
} from "../src/index.js";

const temporaryPaths: string[] = [];
const openVaults: Vault[] = [];

afterEach(async () => {
  for (const vault of openVaults.splice(0)) vault.close();
  for (const temporaryPath of temporaryPaths.splice(0)) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "owncontext-storage-"));
  temporaryPaths.push(root);
  return root;
}

describe("vault storage provider boundary", () => {
  it("rejects a missing provider before creating a database or its directory", async () => {
    const root = await temporaryRoot();
    const databaseDirectory = join(root, "not-created");
    const databasePath = join(databaseDirectory, "vault.sqlite");
    const callWithoutProvider = openVault as unknown as (path: string) => Vault;

    expect(() => callWithoutProvider(databasePath)).toThrow(
      "An explicit OhMyContext vault storage provider is required.",
    );
    expect(existsSync(databaseDirectory)).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("takes an immutable descriptor snapshot when opening the vault", () => {
    const developmentProvider = createNodeSqliteDevelopmentStorageProvider();
    const descriptor: PlaintextVaultStorageDescriptor = {
      providerId: "test-plaintext-provider",
      securityProfile: "plaintext-development",
      atRestEncryption: "none",
      keyManagement: "none",
    };
    const provider: VaultStorageProvider = {
      descriptor,
      inspectSchemaVersion: developmentProvider.inspectSchemaVersion,
      open: (location) => {
        const connection = developmentProvider.open(location);
        (descriptor as { providerId: string }).providerId =
          "changed-during-open";
        return connection;
      },
    };
    const vault = openVault(":memory:", provider);
    openVaults.push(vault);

    expect(vault.storage).toEqual({
      providerId: "test-plaintext-provider",
      securityProfile: "plaintext-development",
      atRestEncryption: "none",
      keyManagement: "none",
    });
    expect(vault.storage).not.toBe(descriptor);
    expect(Object.isFrozen(vault.storage)).toBe(true);

    expect(descriptor.providerId).toBe("changed-during-open");
    (descriptor as { providerId: string }).providerId = "changed-after-open";
    expect(vault.storage.providerId).toBe("test-plaintext-provider");
    expect(
      Reflect.set(vault.storage, "providerId", "changed-through-snapshot"),
    ).toBe(false);
    expect(vault.storage.providerId).toBe("test-plaintext-provider");
  });

  it("rejects inconsistent security metadata before opening storage", async () => {
    const root = await temporaryRoot();
    const databaseDirectory = join(root, "not-created");
    let opened = false;
    const provider = {
      descriptor: {
        providerId: "inconsistent-provider",
        securityProfile: "encrypted-candidate",
        atRestEncryption: "none",
        keyManagement: "os-protected",
      },
      inspectSchemaVersion: () => 0,
      open: () => {
        opened = true;
        return createNodeSqliteDevelopmentStorageProvider().open(":memory:");
      },
    } as unknown as VaultStorageProvider;

    expect(() => openVault(join(databaseDirectory, "vault.sqlite"), provider)).toThrow(
      "Vault storage provider security metadata is inconsistent.",
    );
    expect(opened).toBe(false);
    expect(existsSync(databaseDirectory)).toBe(false);
  });

  it("rejects a future schema inspection before opening or creating storage", async () => {
    const root = await temporaryRoot();
    const databaseDirectory = join(root, "not-created");
    let opened = false;
    const provider: VaultStorageProvider = {
      descriptor: {
        providerId: "future-schema-provider",
        securityProfile: "plaintext-development",
        atRestEncryption: "none",
        keyManagement: "none",
      },
      inspectSchemaVersion: () => 99,
      open: () => {
        opened = true;
        return createNodeSqliteDevelopmentStorageProvider().open(":memory:");
      },
    };

    expect(() => openVault(join(databaseDirectory, "vault.sqlite"), provider)).toThrow(
      "Vault schema version 99 is newer than supported version 3",
    );
    expect(opened).toBe(false);
    expect(existsSync(databaseDirectory)).toBe(false);
  });

  it("opens and persists with an explicitly selected plaintext development provider", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "vault.sqlite");
    const provider = createNodeSqliteDevelopmentStorageProvider();
    const vault = openVault(databasePath, provider);
    openVaults.push(vault);

    expect(existsSync(databasePath)).toBe(true);
    expect(vault.storage).toEqual({
      providerId: "node-sqlite-development",
      securityProfile: "plaintext-development",
      atRestEncryption: "none",
      keyManagement: "none",
    });
  });
});
