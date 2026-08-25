export const NATIVE_UI_LOCALES = ["en", "ko", "ja", "zh-CN"] as const;

export type NativeUiLocale = (typeof NATIVE_UI_LOCALES)[number];

interface NativeUiMessages {
  menu: {
    app: string;
    file: string;
    edit: string;
    view: string;
    window: string;
    about: string;
    services: string;
    hide: string;
    hideOthers: string;
    showAll: string;
    close: string;
    quit: string;
    undo: string;
    redo: string;
    cut: string;
    copy: string;
    paste: string;
    selectAll: string;
    reload: string;
    forceReload: string;
    developerTools: string;
    resetZoom: string;
    zoomIn: string;
    zoomOut: string;
    fullscreen: string;
    minimize: string;
    zoom: string;
    bringAllToFront: string;
  };
  folderPickerTitle: string;
  clearHistory: {
    title: string;
    message: string;
    detail: string;
    keep: string;
    confirm: string;
  };
  purgeSource: {
    title: string;
    message: (name: string) => string;
    detail: (documentCount: number) => string;
    keep: string;
    confirm: string;
  };
}

const english: NativeUiMessages = {
  menu: {
    app: "OhMyContext",
    file: "File",
    edit: "Edit",
    view: "View",
    window: "Window",
    about: "About OhMyContext",
    services: "Services",
    hide: "Hide OhMyContext",
    hideOthers: "Hide Others",
    showAll: "Show All",
    close: "Close Window",
    quit: "Exit OhMyContext",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    reload: "Reload",
    forceReload: "Force Reload",
    developerTools: "Developer Tools",
    resetZoom: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    fullscreen: "Toggle Full Screen",
    minimize: "Minimize",
    zoom: "Zoom",
    bringAllToFront: "Bring All to Front",
  },
  folderPickerTitle: "Choose a folder you are authorized to import",
  clearHistory: {
    title: "Clear local access history?",
    message: "Clear OhMyContext's local access history?",
    detail:
      "This removes only the content-free history stored in this local vault. It cannot retract context already returned to an AI client or retained by its provider.",
    keep: "Keep history",
    confirm: "Clear local history",
  },
  purgeSource: {
    title: "Confirm OhMyContext removal",
    message: (name) => `Remove “${safeDialogLabel(name)}” from OhMyContext?`,
    detail: (documentCount) => {
      const count = safeDocumentCount(documentCount);
      return `This removes ${formatNativeCount("en", count)} indexed ${count === 1 ? "document" : "documents"} and their stored provenance and revision history. The original folder remains unchanged.`;
    },
    keep: "Keep source",
    confirm: "Remove local copy",
  },
};

const korean: NativeUiMessages = {
  menu: {
    app: "OhMyContext",
    file: "파일",
    edit: "편집",
    view: "보기",
    window: "창",
    about: "OhMyContext 정보",
    services: "서비스",
    hide: "OhMyContext 가리기",
    hideOthers: "다른 항목 가리기",
    showAll: "모두 보기",
    close: "창 닫기",
    quit: "OhMyContext 종료",
    undo: "실행 취소",
    redo: "다시 실행",
    cut: "잘라내기",
    copy: "복사",
    paste: "붙여넣기",
    selectAll: "모두 선택",
    reload: "새로고침",
    forceReload: "강제로 새로고침",
    developerTools: "개발자 도구",
    resetZoom: "실제 크기",
    zoomIn: "확대",
    zoomOut: "축소",
    fullscreen: "전체 화면 전환",
    minimize: "최소화",
    zoom: "확대/축소",
    bringAllToFront: "모두 앞으로 가져오기",
  },
  folderPickerTitle: "가져올 권한이 있는 폴더를 선택하세요",
  clearHistory: {
    title: "로컬 접근 기록을 지울까요?",
    message: "OhMyContext의 로컬 접근 기록을 지울까요?",
    detail:
      "이 로컬 보관소에 저장된 질문이나 문서 내용을 포함하지 않는 기록만 삭제합니다. AI 클라이언트에 이미 반환되었거나 제공업체가 보관 중인 컨텍스트는 회수할 수 없습니다.",
    keep: "기록 유지",
    confirm: "로컬 기록 지우기",
  },
  purgeSource: {
    title: "로컬 사본 제거 확인",
    message: (name) => `“${safeDialogLabel(name)}” 폴더의 로컬 사본을 OhMyContext에서 제거할까요?`,
    detail: (documentCount) =>
      `색인된 문서 ${formatNativeCount("ko", documentCount)}개와 관련 출처·변경 이력을 삭제합니다. 원본 폴더는 변경하지 않습니다.`,
    keep: "로컬 사본 유지",
    confirm: "로컬 사본 제거",
  },
};

const japanese: NativeUiMessages = {
  menu: {
    app: "OhMyContext",
    file: "ファイル",
    edit: "編集",
    view: "表示",
    window: "ウインドウ",
    about: "OhMyContextについて",
    services: "サービス",
    hide: "OhMyContextを隠す",
    hideOthers: "ほかを隠す",
    showAll: "すべてを表示",
    close: "ウインドウを閉じる",
    quit: "OhMyContextを終了",
    undo: "取り消す",
    redo: "やり直す",
    cut: "切り取り",
    copy: "コピー",
    paste: "貼り付け",
    selectAll: "すべてを選択",
    reload: "再読み込み",
    forceReload: "強制再読み込み",
    developerTools: "開発者ツール",
    resetZoom: "実際のサイズ",
    zoomIn: "拡大",
    zoomOut: "縮小",
    fullscreen: "フルスクリーンを切り替える",
    minimize: "最小化",
    zoom: "ズーム",
    bringAllToFront: "すべてを手前に移動",
  },
  folderPickerTitle: "インポートする権限を持つフォルダーを選択してください",
  clearHistory: {
    title: "ローカルのアクセス履歴を消去しますか？",
    message: "OhMyContextのローカルアクセス履歴を消去しますか？",
    detail:
      "このローカル保管庫に保存された、検索語や文書内容を含まない履歴だけを削除します。AIクライアントに返された、またはプロバイダーが保持しているコンテキストは取り消せません。",
    keep: "履歴を残す",
    confirm: "ローカル履歴を消去",
  },
  purgeSource: {
    title: "OhMyContextからの削除を確認",
    message: (name) => `“${safeDialogLabel(name)}”をOhMyContextから削除しますか？`,
    detail: (documentCount) =>
      `インデックス済み文書${formatNativeCount("ja", documentCount)}件と保存された来歴情報を削除します。元のフォルダーは変更されません。`,
    keep: "ローカルコピーを残す",
    confirm: "ローカルコピーを削除",
  },
};

const simplifiedChinese: NativeUiMessages = {
  menu: {
    app: "OhMyContext",
    file: "文件",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    about: "关于 OhMyContext",
    services: "服务",
    hide: "隐藏 OhMyContext",
    hideOthers: "隐藏其他应用",
    showAll: "全部显示",
    close: "关闭窗口",
    quit: "退出 OhMyContext",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    reload: "重新加载",
    forceReload: "强制重新加载",
    developerTools: "开发者工具",
    resetZoom: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    fullscreen: "切换全屏",
    minimize: "最小化",
    zoom: "缩放",
    bringAllToFront: "将所有窗口移到前面",
  },
  folderPickerTitle: "请选择您有权导入的文件夹",
  clearHistory: {
    title: "清除本地访问历史记录？",
    message: "要清除 OhMyContext 的本地访问历史记录吗？",
    detail:
      "这只会删除此本地资料库中不包含查询或文档内容的历史记录。无法撤回已返回给 AI 客户端或由其提供商保留的上下文。",
    keep: "保留历史记录",
    confirm: "清除本地历史记录",
  },
  purgeSource: {
    title: "确认从 OhMyContext 移除",
    message: (name) => `要从 OhMyContext 中移除“${safeDialogLabel(name)}”吗？`,
    detail: (documentCount) =>
      `这将删除 ${formatNativeCount("zh-CN", documentCount)} 个已建立索引的文档及其保存的来源及版本记录。原始文件夹不会被更改。`,
    keep: "保留本地副本",
    confirm: "移除本地副本",
  },
};

export const NATIVE_UI_MESSAGES: Readonly<Record<NativeUiLocale, NativeUiMessages>> = {
  en: english,
  ko: korean,
  ja: japanese,
  "zh-CN": simplifiedChinese,
};

export function isNativeUiLocale(value: unknown): value is NativeUiLocale {
  return typeof value === "string" && (NATIVE_UI_LOCALES as readonly string[]).includes(value);
}

export function resolveNativeUiLocale(value: string | null | undefined): NativeUiLocale {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized.startsWith("zh-cn-") ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-sg-") ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  ) {
    return "zh-CN";
  }
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return "en";
}

function formatNativeCount(locale: NativeUiLocale, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    safeDocumentCount(value),
  );
}

function safeDocumentCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeDialogLabel(value: string): string {
  const singleLine = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�");
  const characters = Array.from(singleLine);
  return characters.length <= 160
    ? singleLine
    : `${characters.slice(0, 159).join("")}…`;
}
