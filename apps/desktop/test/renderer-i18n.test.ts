import { describe, expect, it } from "vitest";
import { NATIVE_UI_LOCALES } from "../src/electron/native-i18n.js";
import {
  LOCALE_OPTIONS,
  UI_LOCALES,
  UI_LOCALE_STORAGE_KEY,
  applyDocumentLocale,
  createTranslator,
  detectUiLocale,
  extensionLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  getInitialUiLocale,
  issueMessage,
  issuePath,
  loadStoredUiLocale,
  localizeConnectionPreview,
  message,
  resolveUiLocale,
  storeUiLocale,
  translateMessage,
  type LocaleStorage,
} from "../src/renderer/i18n.js";
import { EN_MESSAGES } from "../src/renderer/i18n.messages.en.js";
import { JA_MESSAGES } from "../src/renderer/i18n.messages.ja.js";
import { KO_MESSAGES } from "../src/renderer/i18n.messages.ko.js";
import { ZH_CN_MESSAGES } from "../src/renderer/i18n.messages.zh-CN.js";

describe("renderer localization", () => {
  it("keeps the renderer and native IPC locale contracts exactly aligned", () => {
    expect(UI_LOCALES).toEqual(["en", "ko", "ja", "zh-CN"]);
    expect(UI_LOCALES).toEqual(NATIVE_UI_LOCALES);
    expect(LOCALE_OPTIONS.map((option) => option.value)).toEqual(UI_LOCALES);
  });

  it.each([
    ["en-US", "en"],
    ["ko-KR", "ko"],
    ["ja-JP", "ja"],
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],
    ["zh-TW", "en"],
    ["zh-HK", "en"],
    ["zh-MO", "en"],
    ["zh-Hant", "en"],
    ["zh-Hant-TW", "en"],
    ["fr-FR", "en"],
  ] as const)("resolves %s to %s", (candidate, expected) => {
    expect(resolveUiLocale(candidate)).toBe(expected);
  });

  it("checks browser language preferences in order without treating unsupported ones as English", () => {
    expect(detectUiLocale(["fr-FR", "ko-KR"])).toBe("ko");
    expect(detectUiLocale(["de-DE", "zh-Hans-CN"])).toBe("zh-CN");
    expect(detectUiLocale(["fr-FR", "de-DE"])).toBe("en");
    // Traditional Chinese is an explicit English fallback, not an unsupported
    // locale that may silently fall through to Simplified Chinese or Korean.
    expect(detectUiLocale(["zh-TW", "ko-KR"])).toBe("en");
  });

  it("persists only exact supported locale identifiers and tolerates storage failures", () => {
    const values = new Map<string, string>();
    const storage: LocaleStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };

    expect(loadStoredUiLocale(storage)).toBeUndefined();
    expect(storeUiLocale("ja", storage)).toBe(true);
    expect(values.get(UI_LOCALE_STORAGE_KEY)).toBe("ja");
    expect(loadStoredUiLocale(storage)).toBe("ja");
    expect(getInitialUiLocale({ storage, languages: ["ko-KR"] })).toBe("ja");

    values.set(UI_LOCALE_STORAGE_KEY, "zh-TW");
    expect(loadStoredUiLocale(storage)).toBeUndefined();
    expect(getInitialUiLocale({ storage, languages: ["ko-KR"] })).toBe("ko");

    const blocked: LocaleStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadStoredUiLocale(blocked)).toBeUndefined();
    expect(storeUiLocale("en", blocked)).toBe(false);
  });

  it("keeps every catalog complete with the same interpolation contract", () => {
    const catalogs = [KO_MESSAGES, JA_MESSAGES, ZH_CN_MESSAGES];
    const englishKeys = Object.keys(EN_MESSAGES).sort();
    expect(englishKeys.length).toBeGreaterThan(300);

    for (const catalog of catalogs) {
      expect(Object.keys(catalog).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        const source = EN_MESSAGES[key as keyof typeof EN_MESSAGES];
        const translated = catalog[key as keyof typeof catalog];
        expect(messageText(translated).trim(), key).not.toBe("");
        expect(placeholders(translated), key).toEqual(placeholders(source));
      }
    }
  });

  it("interpolates, pluralizes, and translates a semantic message after a live switch", () => {
    expect(createTranslator("en")("library.sources.connectedFolders", { count: 1 }))
      .toBe("1 connected folder");
    expect(createTranslator("en")("library.sources.connectedFolders", { count: 2 }))
      .toBe("2 connected folders");
    expect(createTranslator("ko")("library.sources.connectedFolders", { count: 2 }))
      .toBe("연결된 폴더 2개");

    const notice = message("import.sampleSummaryTrySearch", {
      imported: 2,
      updated: 1,
      unchanged: 3,
      skipped: 0,
    });
    expect(translateMessage("en", notice)).toContain("2 imported");
    expect(translateMessage("ja", notice)).toContain("新規 2 件");
    expect(translateMessage("zh-CN", notice)).toContain("已导入 2 项");
    expect(() => createTranslator("en")("preflight.title")).toThrow(
      "Missing localization value",
    );
  });

  it("formats numbers, dates, date-times, and binary byte sizes with the selected locale", () => {
    expect(formatNumber("ko", 1_234.5)).toBe(
      new Intl.NumberFormat("ko").format(1_234.5),
    );
    expect(formatDate("ja", "2026-08-25T04:30:00.000Z", { timeZone: "UTC" })).toBe(
      new Intl.DateTimeFormat("ja", { timeZone: "UTC" }).format(
        new Date("2026-08-25T04:30:00.000Z"),
      ),
    );
    expect(formatDateTime("zh-CN", "2026-08-25T04:30:00.000Z", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    })).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date("2026-08-25T04:30:00.000Z")),
    );
    expect(formatBytes("en", 1_536)).toBe("1.5 KiB");
    expect(createTranslator("ko").bytes(0)).toBe("0 B");
    expect(() => formatBytes("en", -1)).toThrow("non-negative");
    expect(() => formatDate("en", "not-a-date")).toThrow("valid date");
  });

  it("localizes import issue codes and renderer-safe sentinel labels", () => {
    const t = createTranslator("ko");
    expect(issueMessage("hardlink", t)).toContain("하드 링크");
    expect(issueMessage("unknown", t)).toBe(issueMessage("read-error", t));
    expect(issuePath("(unavailable)", t)).toBe("(사용할 수 없음)");
    expect(issuePath("notes/today.md", t)).toBe("notes/today.md");
    expect(extensionLabel("(long extension)", t)).toBe("(긴 확장자)");
    expect(extensionLabel(".md", t)).toBe(".md");
  });

  it("localizes only known preview comments and redaction placeholders", () => {
    const codex = [
      "# OhMyContext-managed block; private local paths are redacted in this display.",
      "[mcp_servers.owncontext]",
      'command = "<private local OhMyContext executable>"',
      'env = { OWNCONTEXT_ALLOWED_COLLECTION = "default" }',
    ].join("\n");
    const localizedCodex = localizeConnectionPreview(codex, "ko");
    expect(localizedCodex).toContain("# OhMyContext 관리 블록");
    expect(localizedCodex).toContain("<비공개 로컬 OhMyContext 실행 파일>");
    expect(localizedCodex).toContain("OWNCONTEXT_ALLOWED_COLLECTION");
    expect(localizedCodex).toContain('"default"');

    const claude = JSON.stringify({
      type: "stdio",
      command: "<private local OhMyContext executable>",
      env: { OWNCONTEXT_VAULT_PATH: "<private local OhMyContext vault>" },
    }, null, 2);
    const localizedClaude = localizeConnectionPreview(claude, "zh-CN");
    expect(JSON.parse(localizedClaude)).toEqual({
      type: "stdio",
      command: "<私密本地 OhMyContext 可执行文件>",
      env: { OWNCONTEXT_VAULT_PATH: "<私密本地 OhMyContext 保管库>" },
    });
    expect(localizeConnectionPreview(localizedClaude, "ja")).toContain(
      "<非公開のローカル OhMyContext 実行ファイル>",
    );
  });

  it("updates the document language without requiring a browser in pure helpers", () => {
    const documentElement = { lang: "en", dir: "" };
    applyDocumentLocale("zh-CN", { documentElement } as unknown as Document);
    expect(documentElement).toEqual({ lang: "zh-CN", dir: "ltr" });
    expect(() => applyDocumentLocale("en", undefined)).not.toThrow();
  });
});

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return Object.values(value).filter((item): item is string => typeof item === "string").join("\n");
}

function placeholders(value: unknown): string[] {
  return [...messageText(value).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)]
    .map((match) => match[1] ?? "")
    .sort();
}
