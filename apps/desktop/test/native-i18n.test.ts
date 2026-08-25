import { describe, expect, it } from "vitest";
import {
  isNativeUiLocale,
  NATIVE_UI_LOCALES,
  NATIVE_UI_MESSAGES,
  resolveNativeUiLocale,
} from "../src/electron/native-i18n.js";

describe("native UI localization", () => {
  it("exposes exactly the four supported locale identifiers", () => {
    expect(NATIVE_UI_LOCALES).toEqual(["en", "ko", "ja", "zh-CN"]);
    expect(Object.keys(NATIVE_UI_MESSAGES)).toEqual(NATIVE_UI_LOCALES);
  });

  it.each([
    ["en", "en"],
    ["en-US", "en"],
    ["ko-KR", "ko"],
    ["ja_JP", "ja"],
    ["zh", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-TW", "en"],
    ["zh-HK", "en"],
    ["de-DE", "en"],
    [undefined, "en"],
  ] as const)("resolves detected locale %s to %s", (input, expected) => {
    expect(resolveNativeUiLocale(input)).toBe(expected);
  });

  it("accepts only exact locale identifiers at the trusted mutation boundary", () => {
    for (const locale of NATIVE_UI_LOCALES) expect(isNativeUiLocale(locale)).toBe(true);
    for (const value of ["en-US", "EN", "zh", "de", "", null, undefined, 1]) {
      expect(isNativeUiLocale(value)).toBe(false);
    }
  });

  it.each(NATIVE_UI_LOCALES)("provides complete non-empty native copy for %s", (locale) => {
    const messages = NATIVE_UI_MESSAGES[locale];
    expect(messages.folderPickerTitle.trim()).not.toBe("");
    expect(Object.values(messages.menu).every((value) => value.trim().length > 0)).toBe(true);
    expect(Object.values(messages.clearHistory).every((value) => value.trim().length > 0)).toBe(true);
    expect(messages.purgeSource.title.trim()).not.toBe("");
    expect(messages.purgeSource.keep.trim()).not.toBe("");
    expect(messages.purgeSource.confirm.trim()).not.toBe("");
    expect(messages.purgeSource.message("sample-source")).toContain("sample-source");
    expect(messages.purgeSource.detail(17)).toContain("17");
  });

  it.each(NATIVE_UI_LOCALES)("sanitizes dynamic native-dialog values for %s", (locale) => {
    const messages = NATIVE_UI_MESSAGES[locale].purgeSource;
    const unsafeLabel = `safe\nname\u202E${"x".repeat(200)}`;
    const renderedLabel = messages.message(unsafeLabel);

    expect(renderedLabel).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    expect(renderedLabel).toContain("�");
    expect(renderedLabel).not.toContain("x".repeat(160));
    expect(messages.detail(-1)).toContain("0");
    expect(messages.detail(Number.NaN)).toContain("0");
  });
});
