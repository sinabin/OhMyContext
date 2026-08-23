import { describe, expect, it } from "vitest";
import {
  ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE,
  CLIENT_KIND_ENVIRONMENT_VARIABLE,
  VAULT_ENVIRONMENT_VARIABLE,
  resolveAllowedCollection,
  resolveClientKind,
  resolveVaultPath,
} from "../src/config.js";

describe("resolveVaultPath", () => {
  it("uses an absolute operator-configured vault path", () => {
    expect(
      resolveVaultPath({
        env: { [VAULT_ENVIRONMENT_VARIABLE]: "/srv/owncontext/user.db" },
        homeDirectory: "/home/ada",
        platform: "linux",
      }),
    ).toBe("/srv/owncontext/user.db");
  });

  it("rejects a relative configured path", () => {
    expect(() =>
      resolveVaultPath({
        env: { [VAULT_ENVIRONMENT_VARIABLE]: "./vault.sqlite3" },
        homeDirectory: "/home/ada",
        platform: "linux",
      }),
    ).toThrow("must be an absolute filesystem path");
  });

  it("uses the Windows local application data directory", () => {
    expect(
      resolveVaultPath({
        env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        homeDirectory: "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\Ada\\AppData\\Local\\OwnContext\\vault.sqlite3");
  });

  it("uses the macOS application support directory", () => {
    expect(
      resolveVaultPath({
        env: {},
        homeDirectory: "/Users/ada",
        platform: "darwin",
      }),
    ).toBe(
      "/Users/ada/Library/Application Support/OwnContext/vault.sqlite3",
    );
  });

  it("uses XDG_DATA_HOME on other Unix platforms", () => {
    expect(
      resolveVaultPath({
        env: { XDG_DATA_HOME: "/data/ada" },
        homeDirectory: "/home/ada",
        platform: "linux",
      }),
    ).toBe("/data/ada/owncontext/vault.sqlite3");
  });

  it("ignores a relative XDG_DATA_HOME and falls back under home", () => {
    expect(
      resolveVaultPath({
        env: { XDG_DATA_HOME: "relative/data" },
        homeDirectory: "/home/ada",
        platform: "linux",
      }),
    ).toBe("/home/ada/.local/share/owncontext/vault.sqlite3");
  });
});

describe("resolveAllowedCollection", () => {
  it("fails closed when a connection has no explicit collection grant", () => {
    expect(() => resolveAllowedCollection({ env: {} })).toThrow(
      ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE,
    );
  });

  it("accepts one bounded launch-time collection grant", () => {
    expect(resolveAllowedCollection({
      env: { [ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE]: " writing " },
    })).toBe("writing");
  });

  it.each(["", "   ", "private\ncollection", "x".repeat(129)])(
    "rejects an unsafe collection grant: %j",
    (collection) => {
      expect(() => resolveAllowedCollection({
        env: { [ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE]: collection },
      })).toThrow(ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE);
    },
  );
});

describe("resolveClientKind", () => {
  it.each(["codex", "claude-code"] as const)(
    "accepts the trusted desktop launch identity %s",
    (clientKind) => {
      expect(resolveClientKind({
        env: { [CLIENT_KIND_ENVIRONMENT_VARIABLE]: clientKind },
      })).toBe(clientKind);
    },
  );

  it.each([undefined, "", "desktop", "unknown", " codex extra "])(
    "fails closed for an unsupported client identity: %j",
    (clientKind) => {
      expect(() => resolveClientKind({
        env: { [CLIENT_KIND_ENVIRONMENT_VARIABLE]: clientKind },
      })).toThrow(CLIENT_KIND_ENVIRONMENT_VARIABLE);
    },
  );
});
