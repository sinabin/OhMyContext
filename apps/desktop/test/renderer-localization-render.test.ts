import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Vitest transpiles the renderer TSX with Vite. The test TypeScript project
// deliberately does not enable JSX because tests themselves contain no JSX.
// @ts-expect-error TS6142 -- App.tsx is covered by the renderer typecheck.
import { App } from "../src/renderer/App.js";
import {
  UI_LOCALE_STORAGE_KEY,
  type UiLocale,
} from "../src/renderer/i18n.js";

const CASES = [
  {
    locale: "en",
    library: "Library",
    connections: "AI connections",
    history: "Access history",
    eyebrow: "LOCAL PERSONAL CONTEXT",
    title: "Find the source behind your memory.",
  },
  {
    locale: "ko",
    library: "라이브러리",
    connections: "AI 연결",
    history: "접근 기록",
    eyebrow: "로컬 개인 컨텍스트",
    title: "기억의 근거가 된 출처를 찾으세요.",
  },
  {
    locale: "ja",
    library: "ライブラリ",
    connections: "AI 接続",
    history: "アクセス履歴",
    eyebrow: "ローカルの個人コンテキスト",
    title: "記憶の根拠となった出典を見つけましょう。",
  },
  {
    locale: "zh-CN",
    library: "资料库",
    connections: "AI 连接",
    history: "访问记录",
    eyebrow: "本地个人上下文",
    title: "找到记忆背后的来源。",
  },
] as const satisfies ReadonlyArray<{
  locale: UiLocale;
  library: string;
  connections: string;
  history: string;
  eyebrow: string;
  title: string;
}>;

const EXPECTED_OPTIONS = [
  ["en", "English"],
  ["ko", "한국어"],
  ["ja", "日本語"],
  ["zh-CN", "简体中文"],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("localized App server rendering", () => {
  it.each(CASES)(
    "renders the stored $locale navigation, header, and four-locale selector",
    (expected) => {
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) =>
            key === UI_LOCALE_STORAGE_KEY ? expected.locale : null,
          setItem: () => undefined,
        },
      });
      vi.stubGlobal("navigator", {
        language: "de-DE",
        languages: ["de-DE"],
      });

      const markup = renderToStaticMarkup(createElement(App));

      expect(buttonText(markup, "nav-library")).toBe(expected.library);
      expect(buttonText(markup, "nav-connections")).toBe(expected.connections);
      expect(buttonText(markup, "nav-history")).toBe(expected.history);
      expect(markup).toContain(`<p class="eyebrow">${expected.eyebrow}</p>`);
      expect(markup).toContain(`<h1>${expected.title}</h1>`);

      expect(markup.match(/<option\b/gu) ?? []).toHaveLength(4);
      for (const [value, label] of EXPECTED_OPTIONS) {
        expect(markup).toMatch(
          new RegExp(`<option[^>]*value="${value}"[^>]*>${label}</option>`, "u"),
        );
      }
    },
  );
});

function buttonText(markup: string, testId: string): string {
  const match = new RegExp(
    `<button[^>]*data-testid="${testId}"[^>]*>([^<]*)</button>`,
    "u",
  ).exec(markup);
  if (!match?.[1]) throw new Error(`Missing rendered button: ${testId}`);
  return match[1];
}
