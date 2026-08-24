import { createConnection, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptOwnContextBrokerConnection,
  OWNCONTEXT_MCP_BROKER_PROTOCOL,
  OwnContextBrokerServerTransport,
} from "../src/broker.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function pipeName(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\owncontext-test-${randomUUID().replaceAll("-", "")}`
    : `/tmp/owncontext-test-${randomUUID()}.sock`;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("OwnContext MCP broker transport", () => {
  it("authenticates the client kind and forwards JSON-RPC frames", async () => {
    const endpoint = pipeName();
    const server = createServer((socket) => {
      void acceptOwnContextBrokerConnection(socket).then(async ({ clientKind, transport }) => {
        expect(clientKind).toBe("codex");
        transport.onmessage = (message) => {
          void transport.send({
            jsonrpc: "2.0",
            id: "request-1",
            result: { echoedMethod: "method" in message ? message.method : undefined },
          });
        };
        await transport.start();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));

    const socket = createConnection(endpoint);
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(line({
      kind: "hello",
      protocol: OWNCONTEXT_MCP_BROKER_PROTOCOL,
      clientKind: "codex",
    }) + line({
      jsonrpc: "2.0",
      id: "request-1",
      method: "ping",
      params: {},
    }));

    const received = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n").filter(Boolean);
        if (lines.length >= 2) resolve(lines[1]!);
      });
      socket.once("error", reject);
    });
    expect(JSON.parse(received)).toMatchObject({
      jsonrpc: "2.0",
      id: "request-1",
      result: { echoedMethod: "ping" },
    });
  });

  it("rejects a client that does not complete the handshake", async () => {
    const endpoint = pipeName();
    const server = createServer((socket) => {
      void acceptOwnContextBrokerConnection(socket).catch(() => socket.destroy());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    const socket = createConnection(endpoint);
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(line({ kind: "hello", protocol: 999, clientKind: "codex" }));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(socket.destroyed).toBe(true);
  });
});
