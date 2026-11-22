// Fabbrico <-> Claude Code bridge.
//
// Claude Code starts this process as an MCP server (stdio, see .mcp.json).
// It exposes Fabbrico's modelling tools to Claude and forwards every call over a
// localhost WebSocket to the Fabbrico page open in your browser, which runs it on
// the live scene. This way the AI work runs on your Claude subscription through
// Claude Code, with no API key in the browser.
//
// stdout belongs to the MCP protocol: log only to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { jsonSchemaOf, TOOL_SPECS, type ToolName, type ToolOutput } from '../src/ai/toolSpecs.ts';
import { MCP_INSTRUCTIONS } from '../src/ai/prompt.ts';

const PORT = Number(process.env.FABBRICO_BRIDGE_PORT ?? 5180);
const CALL_TIMEOUT_MS = 120_000;
const FABBRICO_URL = process.env.FABBRICO_URL ?? 'http://localhost:5173';
// Only pages served from this machine may connect (plus an optional deployed origin).
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const EXTRA_ORIGIN = process.env.FABBRICO_ALLOWED_ORIGIN;

const log = (...a: unknown[]) => console.error('[fabbrico-bridge]', ...a);

// ------------------------------------------------------------ websocket ----

let page: WebSocket | null = null;
let portError: string | null = null;
const pending = new Map<string, { resolve: (o: ToolOutput) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ origin }: { origin?: string }) =>
    !!origin && (LOCAL_ORIGIN.test(origin) || (!!EXTRA_ORIGIN && origin === EXTRA_ORIGIN)),
});

wss.on('listening', () => log(`waiting for Fabbrico on ws://127.0.0.1:${PORT}`));
wss.on('error', (e: NodeJS.ErrnoException) => {
  portError =
    e.code === 'EADDRINUSE'
      ? `Port ${PORT} is already used, probably by the Fabbrico bridge of another Claude Code session. Close that session (or set FABBRICO_BRIDGE_PORT) and restart this one.`
      : `Bridge error: ${e.message}`;
  log(portError);
});

wss.on('connection', (ws) => {
  // The most recent tab wins; an older one is disconnected.
  if (page && page !== ws) page.close(4000, 'Replaced by a newer Fabbrico tab');
  page = ws;
  log('Fabbrico page connected');
  ws.on('message', (raw) => {
    let msg: { type: string; id?: string; ok?: boolean; output?: ToolOutput; error?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type !== 'result' || !msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.output ?? 'ok');
    else p.reject(new Error(msg.error ?? 'Tool failed'));
  });
  ws.on('close', () => {
    if (page === ws) page = null;
    log('Fabbrico page disconnected');
  });
});

async function waitForPage(ms: number): Promise<WebSocket | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (page && page.readyState === WebSocket.OPEN) return page;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function forward(name: string, input: unknown): Promise<ToolOutput> {
  if (portError) throw new Error(portError);
  // Give a tab that is reloading a moment to reconnect.
  const ws = await waitForPage(6000);
  if (!ws)
    throw new Error(
      `Fabbrico is not open. Ask the user to start it (./start.sh in the project folder) and open ${FABBRICO_URL} in the browser, then try again.`,
    );
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Fabbrico did not answer within ${CALL_TIMEOUT_MS / 1000}s (the geometry may be too heavy).`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'call', id, name, input }));
  });
}

// ------------------------------------------------------------------ mcp ----

const server = new Server(
  { name: 'fabbrico', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (Object.keys(TOOL_SPECS) as ToolName[]).map((name) => ({
    name,
    description: TOOL_SPECS[name].description,
    inputSchema: jsonSchemaOf(name) as { type: 'object'; properties?: Record<string, unknown> },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!(name in TOOL_SPECS)) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  try {
    const out = await forward(name, args ?? {});
    const parts = Array.isArray(out) ? out : [out];
    return {
      content: parts.map((p) =>
        typeof p === 'string'
          ? { type: 'text' as const, text: p }
          : { type: 'image' as const, data: p.image, mimeType: 'image/jpeg' },
      ),
    };
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log('MCP server ready');

const shutdown = () => {
  wss.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
