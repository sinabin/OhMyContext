const SAFE_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const SAFE_ERROR_CODE_PATTERN = /^(?:E[A-Z0-9_]{1,31}|SQLITE_[A-Z0-9_]{1,31})$/;

function safeErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "non_error_throwable";

  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code)) {
    return code;
  }

  return SAFE_ERROR_NAMES.has(error.name) ? error.name : "internal_error";
}

/** Formats a diagnostic without including exception messages or local paths. */
export function formatFailureDiagnostic(
  component: string,
  error: unknown,
): string {
  return `[owncontext-mcp] ${component} failed (${safeErrorCategory(error)}).\n`;
}
