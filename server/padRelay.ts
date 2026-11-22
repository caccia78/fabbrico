// Tablet relay: a Vite dev-server plugin that lets a tablet on the same network
// (the "pad" page, pad.html) send tracings to the Fabbrico page on this computer.
//
//   Fabbrico (host, on localhost) ──ws /pad-ws──┐
//                                            ├── relay: forwards messages between
//   iPad (pad, on the LAN)    ──ws /pad-ws──┘    sockets that share the same token
//
// Pairing: Fabbrico makes a random token and shows it in a QR code. Only sockets
// that know it are connected to each other. Hosts must come from this
// computer (localhost), so nobody else on the network can pose as Fabbrico.
// GET /pad-api/info returns this computer's LAN addresses for the QR code.

import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PATH = '/pad-ws';
const LOCAL = /^(127\.|::1$|::ffff:127\.)/;

type DeviceKind = 'tablet' | 'phone';

interface Room {
  host: WebSocket | null;
  /** Connected devices and what they are ("tablet" draws tracings, "phone" does not). */
  pads: Map<WebSocket, DeviceKind>;
  /** Last few messages relayed (type, size, direction), for /pad-api/status. */
  log: { at: string; from: 'pad' | 'host'; type: string; bytes: number; delivered: boolean }[];
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

/** Tells Fabbrico how many devices are connected, and of which kind. */
const devicesMsg = (r: Room) => ({ type: 'pad', connected: r.pads.size, devices: [...r.pads.values()] });

// AR previews: Fabbrico (on this computer) uploads a USDZ model of the plate; the
// phone or tablet opens it with AR Quick Look from an unguessable address.
const AR_TTL_MS = 30 * 60 * 1000;
const AR_MAX = 6;
const arFiles = new Map<string, { bytes: Buffer; at: number }>();

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function padRelay(): Plugin {
  return {
    name: 'fabbrico-pad-relay',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
      const rooms = new Map<string, Room>();
      const room = (token: string) => {
        let r = rooms.get(token);
        if (!r) rooms.set(token, (r = { host: null, pads: new Map(), log: [] }));
        return r;
      };
      const send = (ws: WebSocket | null, msg: unknown) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      };

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '', 'http://x');
        if (url.pathname !== PATH) return; // Vite's own HMR socket etc.
        const token = url.searchParams.get('token') ?? '';
        const role = url.searchParams.get('role');
        const kind: DeviceKind = url.searchParams.get('kind') === 'phone' ? 'phone' : 'tablet';
        const fromThisComputer = LOCAL.test(req.socket.remoteAddress ?? '');
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || (role !== 'host' && role !== 'pad') || (role === 'host' && !fromThisComputer)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const r = room(token);
          if (role === 'host') {
            if (r.host && r.host !== ws) r.host.close(4000, 'Replaced by a newer Fabbrico tab');
            r.host = ws;
            for (const p of r.pads.keys()) send(p, { type: 'status', fabbrico: true });
            // Tablets may have connected first (e.g. Fabbrico was reloaded): tell Fabbrico about them.
            send(ws, devicesMsg(r));
          } else {
            r.pads.set(ws, kind);
            send(ws, { type: 'status', fabbrico: !!r.host });
            send(r.host, devicesMsg(r));
          }
          ws.on('message', (data) => {
            let msg: unknown;
            try {
              msg = JSON.parse(String(data));
            } catch {
              return;
            }
            const type = typeof (msg as { type?: unknown })?.type === 'string' ? (msg as { type: string }).type : '?';
            const delivered = role === 'pad' ? r.host?.readyState === WebSocket.OPEN : r.pads.size > 0;
            r.log = [...r.log.slice(-9), { at: new Date().toISOString(), from: role, type, bytes: String(data).length, delivered }];
            if (role === 'pad') send(r.host, msg);
            else for (const p of r.pads.keys()) send(p, msg);
          });
          ws.on('close', () => {
            if (role === 'host') {
              if (r.host === ws) r.host = null;
              for (const p of r.pads.keys()) send(p, { type: 'status', fabbrico: false });
            } else {
              r.pads.delete(ws);
              send(r.host, devicesMsg(r));
            }
            if (!r.host && !r.pads.size) rooms.delete(token);
          });
        });
      });

      // Diagnostics (this computer only): who is connected, by token prefix.
      server.middlewares.use('/pad-api/status', (req, res) => {
        if (!LOCAL.test(req.socket.remoteAddress ?? '')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            [...rooms].map(([token, r]) => ({ token: token.slice(0, 4) + '…', host: !!r.host, pads: r.pads.size, recent: r.log })),
          ),
        );
      });

      // Upload (Fabbrico, this computer only): body = USDZ bytes. Returns the path the device opens.
      server.middlewares.use('/pad-api/ar-upload', (req, res) => {
        const origin = req.headers.origin;
        if (
          req.method !== 'POST' ||
          !LOCAL.test(req.socket.remoteAddress ?? '') ||
          req.headers['x-fabbrico'] !== '1' ||
          (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin))
        ) {
          res.statusCode = 403;
          res.end();
          return;
        }
        readBody(req, 64 * 1024 * 1024).then(
          (bytes) => {
            const now = Date.now();
            for (const [k, v] of arFiles) if (now - v.at > AR_TTL_MS) arFiles.delete(k);
            while (arFiles.size >= AR_MAX) arFiles.delete(arFiles.keys().next().value!);
            const id = randomBytes(16).toString('hex');
            arFiles.set(id, { bytes, at: now });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: `/pad-api/ar/${id}.usdz` }));
          },
          () => {
            res.statusCode = 413;
            res.end();
          },
        );
      });

      // Download (any device on the network that knows the address).
      server.middlewares.use('/pad-api/ar/', (req, res) => {
        const m = (req.url ?? '').match(/^\/?([0-9a-f]{32})\.usdz$/);
        const file = m && arFiles.get(m[1]);
        if (!file || Date.now() - file.at > AR_TTL_MS) {
          res.statusCode = 404;
          res.end('This AR preview has expired: ask for a new one');
          return;
        }
        res.setHeader('Content-Type', 'model/vnd.usdz+zip');
        res.setHeader('Content-Length', String(file.bytes.length));
        res.setHeader('Cache-Control', 'no-store');
        res.end(file.bytes);
      });

      server.middlewares.use('/pad-api/info', (req, res) => {
        // Only Fabbrico itself (on this computer) needs this.
        if (!LOCAL.test(req.socket.remoteAddress ?? '')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const port = (server.httpServer?.address() as { port?: number } | null)?.port ?? server.config.server.port;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ addresses: lanAddresses(), port }));
      });
    },
  };
}
