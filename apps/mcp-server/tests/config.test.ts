import { describe, expect, it } from "vitest";
import {
  VAULT_ENVIRONMENT_VARIABLE,
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
