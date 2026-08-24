import { createConnection, type Server, type Socket } from "node:net";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

export const OWNCONTEXT_MCP_BROKER_PIPE = "OWNCONTEXT_MCP_BROKER_PIPE";
export const OWNCONTEXT_MCP_BROKER_PROTOCOL = 1;
const MAX_BROKER_BUFFER_BYTES = 10 * 1024 * 1024;

export type BrokerClientKind = "codex" | "claude-code";

type BrokerHello = {
  kind: "hello";
  protocol: number;
  clientKind: BrokerClientKind;
};

type BrokerReady = {
  kind: "ready";
  protocol: number;
};

function isBrokerHello(value: unknown): value is BrokerHello {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).kind === "hello" &&
    (value as Record<string, unknown>).protocol === OWNCONTEXT_MCP_BROKER_PROTOCOL &&
    ((value as Record<string, unknown>).clientKind === "codex" ||
      (value as Record<string, unknown>).clientKind === "claude-code");
}

function isBrokerReady(value: unknown): value is BrokerReady {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).kind === "ready" &&
    (value as Record<string, unknown>).protocol === OWNCONTEXT_MCP_BROKER_PROTOCOL;
}

class LineBuffer {
  private buffer = Buffer.alloc(0);

  public append(chunk: Buffer): void {
    const nextSize = this.buffer.byteLength + chunk.byteLength;
    if (nextSize > MAX_BROKER_BUFFER_BYTES) {
      this.buffer = Buffer.alloc(0);
      throw new Error("OwnContext MCP broker frame buffer exceeded its limit.");
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  public readLines(): string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      lines.push(this.buffer.toString("utf8", 0, newline).replace(/\r$/u, ""));
      this.buffer = this.buffer.subarray(newline + 1);
    }
    return lines;
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error("OwnContext MCP broker received invalid JSON.");
  }
}

function writeLine(socket: Socket, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  return new Promise((resolve, reject) => {
    socket.write(line, "utf8", (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export type BrokerTransportConnection = {
  clientKind: BrokerClientKind;
  transport: OwnContextBrokerServerTransport;
};

/**
 * Accepts one same-user named-pipe connection and consumes its handshake.
 * The caller owns the returned MCP server lifecycle; this function never
 * opens a vault or interprets tool arguments.
 */
export async function acceptOwnContextBrokerConnection(
  socket: Socket,
): Promise<BrokerTransportConnection> {
  socket.setNoDelay(true);
  socket.pause();
  const lineBuffer = new LineBuffer();
  const initialMessages: JSONRPCMessage[] = [];
  let hello: BrokerHello | undefined;

  const chunks = socket.readableLength > 0 ? [socket.read(socket.readableLength)] : [];
  for (const chunk of chunks) {
    if (chunk) lineBuffer.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.pause();
      resolve();
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error("OwnContext MCP broker closed before handshake."));
    const onData = (chunk: Buffer): void => {
      try {
        lineBuffer.append(chunk);
        for (const line of lineBuffer.readLines()) {
          const value = parseJsonLine(line);
          if (!hello) {
            if (!isBrokerHello(value)) throw new Error("OwnContext MCP broker handshake was rejected.");
            hello = value;
            continue;
          }
          const message = JSONRPCMessageSchema.parse(value);
          initialMessages.push(message);
        }
        if (hello) {
          succeed();
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("OwnContext MCP broker handshake failed."));
      }
    };
    socket.on("error", onError);
    socket.once("close", onClose);
    socket.on("data", onData);
    socket.resume();
  });

  if (!hello) throw new Error("OwnContext MCP broker handshake was incomplete.");
  await writeLine(socket, {
    kind: "ready",
    protocol: OWNCONTEXT_MCP_BROKER_PROTOCOL,
  } satisfies BrokerReady);
  const transport = new OwnContextBrokerServerTransport(socket, initialMessages);
  return { clientKind: hello.clientKind, transport };
}

export class OwnContextBrokerServerTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private started = false;
  private closed = false;
  private readonly lineBuffer = new LineBuffer();

  public constructor(
    private readonly socket: Socket,
    private readonly initialMessages: readonly JSONRPCMessage[] = [],
  ) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error("OwnContext MCP broker transport already started.");
    this.started = true;
    this.socket.on("data", this.onData);
    this.socket.once("error", this.onSocketError);
    this.socket.once("close", this.onSocketClose);
    queueMicrotask(() => {
      for (const message of this.initialMessages) this.onmessage?.(message);
      this.socket.resume();
    });
  }

  public async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error("OwnContext MCP broker transport is closed.");
    await writeLine(this.socket, message);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.off("data", this.onData);
    this.socket.destroy();
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer): void => {
    try {
      this.lineBuffer.append(chunk);
      for (const line of this.lineBuffer.readLines()) {
        const message = deserializeMessage(line);
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onSocketError(error instanceof Error ? error : new Error("Broker message parsing failed."));
    }
  };

  private readonly onSocketError = (error: Error): void => {
    this.onerror?.(error);
    void this.close();
  };

  private readonly onSocketClose = (): void => {
    if (!this.closed) {
      this.closed = true;
      this.onclose?.();
    }
  };
}

/** Forwards stdio MCP frames through the desktop-owned named pipe. */
export async function runBrokerStdioServer(
  pipeName: string,
  clientKind: BrokerClientKind,
): Promise<void> {
  if (!pipeName.startsWith("\\\\.\\pipe\\")) {
    throw new Error("OWNCONTEXT_MCP_BROKER_PIPE must be a Windows named pipe.");
  }
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = createConnection(pipeName);
    connection.once("connect", () => resolve(connection));
    connection.once("error", reject);
  });
  socket.setNoDelay(true);
  await writeLine(socket, {
    kind: "hello",
    protocol: OWNCONTEXT_MCP_BROKER_PROTOCOL,
    clientKind,
  } satisfies BrokerHello);

  const stdinBuffer = new LineBuffer();
  const socketBuffer = new LineBuffer();
  let ready = false;
  const pending: JSONRPCMessage[] = [];
  const stdinData = (chunk: Buffer): void => {
    try {
      stdinBuffer.append(chunk);
      for (const line of stdinBuffer.readLines()) {
        const message = JSONRPCMessageSchema.parse(parseJsonLine(line));
        if (ready) void writeLine(socket, message);
        else pending.push(message);
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "MCP broker input failed."}\n`);
      socket.destroy();
    }
  };

  const completion = new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      try {
        socketBuffer.append(chunk);
        for (const line of socketBuffer.readLines()) {
          const value = parseJsonLine(line);
          if (!ready) {
            if (!isBrokerReady(value)) throw new Error("OwnContext MCP broker was not ready.");
            ready = true;
            for (const message of pending.splice(0)) void writeLine(socket, message);
            continue;
          }
          process.stdout.write(serializeMessage(JSONRPCMessageSchema.parse(value)));
        }
      } catch (error) {
        reject(error);
        socket.destroy();
      }
    });
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
  process.stdin.on("data", stdinData);
  process.stdin.once("end", () => socket.end());
  await completion;
  process.stdin.off("data", stdinData);
}
