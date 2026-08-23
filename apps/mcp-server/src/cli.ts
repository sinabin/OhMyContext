#!/usr/bin/env node

import { formatFailureDiagnostic } from "./diagnostics.js";
import { runStdioServer } from "./stdio.js";

function diagnostic(error: unknown): void {
  process.stderr.write(formatFailureDiagnostic("startup", error));
}

void runStdioServer().catch((error: unknown) => {
  diagnostic(error);
  process.exitCode = 1;
});
