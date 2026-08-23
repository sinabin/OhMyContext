import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SAMPLE_LIBRARY_PROVENANCE_ROOT,
  SAMPLE_LIBRARY_SOURCE_LABEL,
  SAMPLE_LIBRARY_SUGGESTED_QUERY,
} from "./sample-library.js";

export const GUI_SMOKE_ARGUMENT = "--owncontext-gui-smoke";
export const GUI_SMOKE_ROOT_ENV = "OWNCONTEXT_GUI_SMOKE_ROOT";
export const GUI_SMOKE_NONCE_ENV = "OWNCONTEXT_GUI_SMOKE_NONCE";

export interface GuiSmokeContext {
  rootPath: string;
  userDataPath: string;
  codexConfigPath: string;
  claudeCodeConfigPath: string;
  resultPath: string;
  nonce: string;
}

export interface GuiSmokeRenderer {
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
}

export interface GuiSmokeJourneyEvidence {
  readonly sampleSourceReady: true;
  readonly sampleSourceLabel: typeof SAMPLE_LIBRARY_SOURCE_LABEL;
  readonly suggestedQuery: typeof SAMPLE_LIBRARY_SUGGESTED_QUERY;
  readonly sampleProvenanceVerified: true;
  readonly resultCardCount: number;
}

const GUI_JOURNEY_RENDERER_TIMEOUT_MS = 15_000;
const GUI_JOURNEY_EXECUTION_TIMEOUT_MS = 18_000;
const GUI_JOURNEY_POLL_INTERVAL_MS = 100;
const MAX_GUI_RESULT_CARDS = 12;

function isStrictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

export function prepareGuiSmoke(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  temporaryDirectory = tmpdir(),
): GuiSmokeContext | undefined {
  if (argv[1] !== GUI_SMOKE_ARGUMENT) return undefined;

  const requestedRoot = environment[GUI_SMOKE_ROOT_ENV];
  const nonce = environment[GUI_SMOKE_NONCE_ENV];
  if (
    !requestedRoot ||
    !isAbsolute(requestedRoot) ||
    !nonce ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      nonce,
    )
  ) {
    throw new Error("Invalid GUI smoke-test environment.");
  }

  const metadata = lstatSync(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("GUI smoke root must be a regular directory.");
  }
  const realTemporaryDirectory = realpathSync(temporaryDirectory);
  const realRoot = realpathSync(requestedRoot);
  if (!isStrictDescendant(realTemporaryDirectory, realRoot)) {
    throw new Error("GUI smoke root must be inside the OS temporary directory.");
  }

  const userDataPath = join(realRoot, "electron-user-data");
  const codexConfigPath = join(realRoot, "codex", "config.toml");
  const claudeCodeConfigPath = join(realRoot, "claude", ".claude.json");
  const resultPath = join(realRoot, "renderer-ready.json");
  for (const candidate of [
    userDataPath,
    dirname(codexConfigPath),
    dirname(claudeCodeConfigPath),
    resultPath,
  ]) {
    if (existsSync(candidate)) {
      throw new Error("GUI smoke output already exists.");
    }
  }
  mkdirSync(userDataPath, { recursive: false });
  mkdirSync(dirname(codexConfigPath), { recursive: false });
  mkdirSync(dirname(claudeCodeConfigPath), { recursive: false });

  return {
    rootPath: realRoot,
    userDataPath,
    codexConfigPath,
    claudeCodeConfigPath,
    resultPath,
    nonce,
  };
}

export function writeGuiSmokeSuccess(
  context: GuiSmokeContext,
  isPackaged: boolean,
  evidence: GuiSmokeJourneyEvidence,
): void {
  const payload = {
    status: "first-run-sample-search-complete",
    nonce: context.nonce,
    isPackaged,
    ...validateJourneyEvidence(evidence),
  };
  writeFileSync(context.resultPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

/**
 * Exercises the packaged renderer through the same visible controls a new user
 * sees. It returns content-free evidence only after a built-in sample result is
 * present in the DOM.
 */
export async function runGuiSmokeJourney(
  renderer: GuiSmokeRenderer,
): Promise<GuiSmokeJourneyEvidence> {
  const script = renderGuiJourneyScript();
  let timer: NodeJS.Timeout | undefined;
  const executionTimeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Packaged GUI first-run journey timed out."));
    }, GUI_JOURNEY_EXECUTION_TIMEOUT_MS);
  });

  try {
    const rawEvidence = await Promise.race([
      renderer.executeJavaScript(script, true),
      executionTimeout,
    ]);
    return validateJourneyEvidence(rawEvidence);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateJourneyEvidence(value: unknown): GuiSmokeJourneyEvidence {
  if (!value || typeof value !== "object") {
    throw new Error("Packaged GUI first-run evidence is invalid.");
  }

  const evidence = value as Record<string, unknown>;
  if (
    evidence.sampleSourceReady !== true ||
    evidence.sampleSourceLabel !== SAMPLE_LIBRARY_SOURCE_LABEL ||
    evidence.suggestedQuery !== SAMPLE_LIBRARY_SUGGESTED_QUERY ||
    evidence.sampleProvenanceVerified !== true ||
    !Number.isInteger(evidence.resultCardCount) ||
    (evidence.resultCardCount as number) < 1 ||
    (evidence.resultCardCount as number) > MAX_GUI_RESULT_CARDS
  ) {
    throw new Error("Packaged GUI first-run evidence is invalid.");
  }

  return {
    sampleSourceReady: true,
    sampleSourceLabel: SAMPLE_LIBRARY_SOURCE_LABEL,
    suggestedQuery: SAMPLE_LIBRARY_SUGGESTED_QUERY,
    sampleProvenanceVerified: true,
    resultCardCount: evidence.resultCardCount as number,
  };
}

function renderGuiJourneyScript(): string {
  const sourceLabel = JSON.stringify(SAMPLE_LIBRARY_SOURCE_LABEL);
  const suggestedQuery = JSON.stringify(SAMPLE_LIBRARY_SUGGESTED_QUERY);
  const provenanceRoot = JSON.stringify(SAMPLE_LIBRARY_PROVENANCE_ROOT);

  return `
(async () => {
  const expectedSourceLabel = ${sourceLabel};
  const expectedQuery = ${suggestedQuery};
  const expectedProvenanceRoot = ${provenanceRoot};
  const deadline = Date.now() + ${GUI_JOURNEY_RENDERER_TIMEOUT_MS};
  const pollInterval = ${GUI_JOURNEY_POLL_INTERVAL_MS};
  const wait = () => new Promise((resolvePromise) => setTimeout(resolvePromise, pollInterval));
  const visibleError = () => {
    const alert = document.querySelector('[role="alert"]');
    return alert instanceof HTMLElement ? alert.innerText.trim() : '';
  };
  const failOnVisibleError = () => {
    const message = visibleError();
    if (message) throw new Error('OwnContext renderer reported an error during GUI smoke.');
  };
  const waitFor = async (label, read) => {
    while (Date.now() < deadline) {
      failOnVisibleError();
      const value = read();
      if (value) return value;
      await wait();
    }
    throw new Error('Timed out waiting for ' + label + '.');
  };
  const buttonWithText = (selector, text) => {
    const buttons = Array.from(document.querySelectorAll(selector));
    return buttons.find((button) =>
      button instanceof HTMLButtonElement &&
      !button.disabled &&
      button.innerText.trim() === text
    );
  };

  await waitFor('the first-run sample action', () =>
    buttonWithText('.empty-actions button', 'Try sample library')
  ).then((button) => button.click());

  const searchInput = await waitFor('the imported sample and suggested query', () => {
    const sourceNames = Array.from(document.querySelectorAll('.source-item strong'));
    const sampleSourceReady = sourceNames.some((element) =>
      element instanceof HTMLElement && element.innerText.trim() === expectedSourceLabel
    );
    const input = document.querySelector('input[aria-label="Search personal context"]');
    const submit = document.querySelector('form.search button[type="submit"]');
    if (
      sampleSourceReady &&
      input instanceof HTMLInputElement &&
      input.value === expectedQuery &&
      submit instanceof HTMLButtonElement &&
      !submit.disabled
    ) {
      return input;
    }
    return undefined;
  });

  if (searchInput.value !== expectedQuery) {
    throw new Error('The suggested sample query was not prepared.');
  }
  const searchForm = searchInput.closest('form.search');
  if (!(searchForm instanceof HTMLFormElement)) {
    throw new Error('The search form is unavailable.');
  }
  searchForm.requestSubmit();

  const sampleCards = await waitFor('a sample search result card', () => {
    const cards = Array.from(document.querySelectorAll('.result-card'));
    const matches = cards.filter((card) => {
      const source = card.querySelector('.result-meta span');
      const sourceUri = source?.getAttribute('title') ?? '';
      return sourceUri.startsWith(expectedProvenanceRoot);
    });
    return matches.length > 0 ? matches : undefined;
  });

  return {
    sampleSourceReady: true,
    sampleSourceLabel: expectedSourceLabel,
    suggestedQuery: expectedQuery,
    sampleProvenanceVerified: true,
    resultCardCount: sampleCards.length,
  };
})()
`;
}
