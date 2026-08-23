interface RendererSafeLaunch {
  allowedCollection: string;
  runtime: "node" | "electron";
}

const EXECUTABLE_PLACEHOLDER = "<private local OwnContext executable>";
const SERVER_PLACEHOLDER = "<private local OwnContext MCP server>";
const VAULT_PLACEHOLDER = "<private local OwnContext vault>";

export function renderRendererSafeCodexPreview(
  launch: RendererSafeLaunch,
): string {
  const environment = [
    `OWNCONTEXT_VAULT_PATH = ${JSON.stringify(VAULT_PLACEHOLDER)}`,
    `OWNCONTEXT_ALLOWED_COLLECTION = ${JSON.stringify(launch.allowedCollection)}`,
  ];
  if (launch.runtime === "electron") {
    environment.push('ELECTRON_RUN_AS_NODE = "1"');
  }
  return [
    "# OwnContext-managed block; private local paths are redacted in this display.",
    "[mcp_servers.owncontext]",
    `command = ${JSON.stringify(EXECUTABLE_PLACEHOLDER)}`,
    `args = [${JSON.stringify(SERVER_PLACEHOLDER)}]`,
    `env = { ${environment.join(", ")} }`,
  ].join("\n");
}

export function renderRendererSafeClaudeCodePreview(
  launch: RendererSafeLaunch,
): string {
  return JSON.stringify({
    type: "stdio",
    command: EXECUTABLE_PLACEHOLDER,
    args: [SERVER_PLACEHOLDER],
    env: {
      OWNCONTEXT_ALLOWED_COLLECTION: launch.allowedCollection,
      OWNCONTEXT_MANAGED_BY: "owncontext-desktop-v1",
      OWNCONTEXT_VAULT_PATH: VAULT_PLACEHOLDER,
      ...(launch.runtime === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  }, null, 2);
}

export function omitConnectionMutationSnippet<
  T extends { snippet?: string | undefined },
>(result: T): Omit<T, "snippet"> {
  const { snippet, ...rendererSafeResult } = result;
  void snippet;
  return rendererSafeResult;
}
