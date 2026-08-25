import { useCallback, useEffect, useMemo, useState } from "react";
import { EN_MESSAGES } from "./i18n.messages.en.js";
import { JA_MESSAGES } from "./i18n.messages.ja.js";
import { KO_MESSAGES } from "./i18n.messages.ko.js";
import { ZH_CN_MESSAGES } from "./i18n.messages.zh-CN.js";

export const UI_LOCALES = ["en", "ko", "ja", "zh-CN"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "ohmycontext.ui-locale.v1";

export const LOCALE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "简体中文" },
] as const satisfies ReadonlyArray<{ value: UiLocale; label: string }>;

type PluralTemplate = Readonly<{
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}>;

type MessageTemplate = string | PluralTemplate;
export type MessageKey = keyof typeof EN_MESSAGES;
type Catalog = Readonly<Record<MessageKey, MessageTemplate>>;

const CATALOGS = {
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
  ja: JA_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES,
} as const satisfies Readonly<Record<UiLocale, Catalog>>;

export type MessageValue = string | number;
export type MessageValues = Readonly<Record<string, MessageValue>>;

export interface LocalizedMessage {
  readonly key: MessageKey;
  readonly values?: MessageValues;
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Translator {
  (key: MessageKey, values?: MessageValues): string;
  readonly locale: UiLocale;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  date(
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  dateTime(
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  bytes(value: number): string;
}

export interface UiLocaleController {
  readonly locale: UiLocale;
  readonly setLocale: (locale: UiLocale) => void;
  readonly t: Translator;
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && UI_LOCALES.some((locale) => locale === value);
}

/**
 * Resolves an operating-system/browser locale to one of the four UI locales.
 * Traditional-Chinese locales deliberately fall back to English rather than
 * silently receiving Simplified Chinese copy.
 */
export function resolveUiLocale(value: unknown): UiLocale {
  return matchUiLocale(value) ?? "en";
}

function matchUiLocale(value: unknown): UiLocale | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";

  if (
    normalized === "zh-tw" ||
    normalized.startsWith("zh-tw-") ||
    normalized === "zh-hk" ||
    normalized.startsWith("zh-hk-") ||
    normalized === "zh-mo" ||
    normalized.startsWith("zh-mo-") ||
    normalized === "zh-hant" ||
    normalized.startsWith("zh-hant-") ||
    normalized.includes("-hant-")
  ) {
    return "en";
  }

  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized.startsWith("zh-cn-") ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-sg-") ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-") ||
    normalized.includes("-hans-")
  ) {
    return "zh-CN";
  }

  return undefined;
}

export function detectUiLocale(languages?: readonly string[]): UiLocale {
  const candidates = languages ?? browserLanguages();
  for (const candidate of candidates) {
    const locale = matchUiLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

export function loadStoredUiLocale(
  storage: LocaleStorage | undefined = browserStorage(),
): UiLocale | undefined {
  if (!storage) return undefined;
  try {
    const value = storage.getItem(UI_LOCALE_STORAGE_KEY);
    return isUiLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeUiLocale(
  locale: UiLocale,
  storage: LocaleStorage | undefined = browserStorage(),
): boolean {
  if (!isUiLocale(locale) || !storage) return false;
  try {
    storage.setItem(UI_LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

export function getInitialUiLocale(options: {
  readonly storage?: LocaleStorage | undefined;
  readonly languages?: readonly string[] | undefined;
} = {}): UiLocale {
  return loadStoredUiLocale(options.storage ?? browserStorage()) ??
    detectUiLocale(options.languages);
}

export function applyDocumentLocale(
  locale: UiLocale,
  target: Pick<Document, "documentElement"> | undefined = browserDocument(),
): void {
  if (!target) return;
  target.documentElement.lang = locale;
  target.documentElement.dir = "ltr";
}

export function message(
  key: MessageKey,
  values?: MessageValues,
): LocalizedMessage {
  return values === undefined ? { key } : { key, values };
}

export function translateMessage(
  locale: UiLocale,
  value: LocalizedMessage,
): string {
  return createTranslator(locale)(value.key, value.values);
}

export function createTranslator(locale: UiLocale): Translator {
  const resolvedLocale = isUiLocale(locale) ? locale : "en";
  const translate = ((key: MessageKey, values?: MessageValues): string => {
    const template = CATALOGS[resolvedLocale][key];
    const selected = selectTemplate(resolvedLocale, template, values);
    return interpolate(resolvedLocale, selected, values);
  }) as Translator;

  Object.defineProperties(translate, {
    locale: { value: resolvedLocale, enumerable: true },
    number: {
      value: (value: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(resolvedLocale, value, options),
    },
    date: {
      value: (
        value: Date | number | string,
        options?: Intl.DateTimeFormatOptions,
      ) => formatDate(resolvedLocale, value, options),
    },
    dateTime: {
      value: (
        value: Date | number | string,
        options?: Intl.DateTimeFormatOptions,
      ) => formatDateTime(resolvedLocale, value, options),
    },
    bytes: {
      value: (value: number) => formatBytes(resolvedLocale, value),
    },
  });

  return translate;
}

export function formatNumber(
  locale: UiLocale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) throw new RangeError("A finite number is required.");
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  locale: UiLocale,
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  },
): string {
  return new Intl.DateTimeFormat(locale, options).format(validDate(value));
}

export function formatDateTime(
  locale: UiLocale,
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  return new Intl.DateTimeFormat(locale, options).format(validDate(value));
}

export function formatBytes(locale: UiLocale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("Byte size must be a finite non-negative number.");
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const formatted = formatNumber(locale, value, unitIndex === 0
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${formatted} ${units[unitIndex]}`;
}

export function issueMessage(code: string, t: Translator): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    hardlink: "issue.hardlink",
    "invalid-utf8": "issue.invalidUtf8",
    "outside-root": "issue.outsideRoot",
    "read-error": "issue.readError",
    symlink: "issue.symlink",
    "too-large": "issue.tooLarge",
    "unsupported-file": "issue.unsupportedFile",
  };
  return t(keys[code] ?? "issue.readError");
}

export function issuePath(value: string, t: Translator): string {
  return value === "(unavailable)" ? t("sentinel.issuePathUnavailable") : value;
}

export function extensionLabel(value: string, t: Translator): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    "(none)": "sentinel.extensionNone",
    "(other)": "sentinel.extensionOther",
    "(long extension)": "sentinel.extensionLong",
  };
  const key = keys[value];
  return key ? t(key) : value;
}

/** Localizes only known redaction labels/comments, never technical keys or values. */
export function localizeConnectionPreview(
  snippet: string,
  locale: UiLocale,
): string {
  const target = createTranslator(locale);
  const keys = [
    "preview.comment",
    "preview.placeholder.executable",
    "preview.placeholder.server",
    "preview.placeholder.vault",
    "preview.placeholder.broker",
  ] as const satisfies readonly MessageKey[];

  let localized = snippet;
  for (const key of keys) {
    for (const sourceLocale of UI_LOCALES) {
      const source = createTranslator(sourceLocale)(key);
      localized = localized.split(source).join(target(key));
    }
  }
  return localized;
}

export function useUiLocale(initialLocale?: UiLocale): UiLocaleController {
  const [locale, setLocaleState] = useState<UiLocale>(() =>
    initialLocale ?? getInitialUiLocale()
  );
  const setLocale = useCallback((nextLocale: UiLocale): void => {
    if (!isUiLocale(nextLocale)) return;
    storeUiLocale(nextLocale);
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  const t = useMemo(() => createTranslator(locale), [locale]);
  return useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
}

function selectTemplate(
  locale: UiLocale,
  template: MessageTemplate,
  values: MessageValues | undefined,
): string {
  if (typeof template === "string") return template;
  const count = values?.count;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    throw new TypeError("Plural messages require a finite numeric count.");
  }
  const category = new Intl.PluralRules(locale).select(count);
  return template[category] ?? template.other;
}

function interpolate(
  locale: UiLocale,
  template: string,
  values: MessageValues | undefined,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      throw new TypeError(`Missing localization value: ${name}`);
    }
    return typeof value === "number" ? formatNumber(locale, value) : value;
  });
}

function validDate(value: Date | number | string): Date {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new RangeError("A valid date is required.");
  return result;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];
}

function browserStorage(): LocaleStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function browserDocument(): Pick<Document, "documentElement"> | undefined {
  return typeof document === "undefined" ? undefined : document;
}
