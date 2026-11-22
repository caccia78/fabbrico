// Local actions: a Vite dev-server plugin that lets the Fabbrico page do things a
// browser page cannot do on its own, on this computer only:
//
//   GET  /local-api/info          export folder and which slicers are installed
//   POST /local-api/export        body = model bytes; saves them in the export folder,
//                                 then optionally opens them in a slicer
//   POST /local-api/open-folder   shows the export folder in Finder / Explorer / file manager
//   /local-api/library/…          the experience library on disk (see library.ts)
//
// The export folder is ~/Documents/Fabbrico (override with FABBRICO_EXPORT_DIR).
//
// Safety: requests must come from this computer (the dev server also listens on the
// LAN for the tablet), carry the X-Fabbrico header (so a web page in another origin
// cannot send them without a CORS preflight, which is never granted) and, when the
// browser sends an Origin, it must be a localhost one. File names are sanitised and
// programs are started with execFile (no shell).

import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { handleLibrary } from './library.ts';

const LOCAL = /^(127\.|::1$|::ffff:127\.)/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BYTES = 256 * 1024 * 1024;

const exportDir = () => process.env.FABBRICO_EXPORT_DIR || join(homedir(), 'Documents', 'Fabbrico');

/** Fabbrico was called Forma: move ~/Documents/Forma (exports and library) to the new folder, once. */
function moveLegacyFolder() {
  if (process.env.FABBRICO_EXPORT_DIR || process.env.FABBRICO_LIBRARY_DIR) return;
  const legacy = join(homedir(), 'Documents', 'Forma');
  const target = exportDir();
  try {
    if (existsSync(legacy) && !existsSync(target)) {
      renameSync(legacy, target);
      console.log(`[fabbrico] moved ${legacy} to ${target}`);
    }
  } catch (e) {
    console.warn(`[fabbrico] could not move ${legacy} to ${target}: ${(e as Error).message}`);
  }
}

interface Slicer {
  id: string;
  name: string;
  /** Candidate install locations: .app bundles on macOS, executables elsewhere. */
  paths: Partial<Record<NodeJS.Platform, string[]>>;
}

const SLICERS: Slicer[] = [
  {
    id: 'bambu',
    name: 'Bambu Studio',
    paths: {
      darwin: ['/Applications/BambuStudio.app', join(homedir(), 'Applications/BambuStudio.app')],
      win32: ['C:\\Program Files\\Bambu Studio\\bambu-studio.exe'],
      linux: ['/usr/bin/bambu-studio', '/usr/local/bin/bambu-studio'],
    },
  },
  {
    id: 'orca',
    name: 'OrcaSlicer',
    paths: {
      darwin: ['/Applications/OrcaSlicer.app', join(homedir(), 'Applications/OrcaSlicer.app')],
      win32: ['C:\\Program Files\\OrcaSlicer\\orca-slicer.exe'],
      linux: ['/usr/bin/orca-slicer', '/usr/local/bin/orca-slicer'],
    },
  },
  {
    id: 'prusa',
    name: 'PrusaSlicer',
    paths: {
      darwin: ['/Applications/PrusaSlicer.app', join(homedir(), 'Applications/PrusaSlicer.app')],
      win32: ['C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe'],
      linux: ['/usr/bin/prusa-slicer', '/usr/local/bin/prusa-slicer'],
    },
  },
];

function slicerPath(s: Slicer): string | null {
  return (s.paths[platform()] ?? []).find((p) => existsSync(p)) ?? null;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    child.unref();
  });
}

/** Opens a file in an application (by install path), or a folder in the file manager. */
async function openWith(target: string, appPath: string | null) {
  const os = platform();
  if (os === 'darwin') return run('open', appPath ? ['-a', appPath, target] : [target]);
  if (appPath) {
    // Slicers stay open: don't wait for them to exit.
    execFile(appPath, [target], { windowsHide: true }).unref();
    return;
  }
  if (os === 'win32') {
    // explorer.exe returns exit code 1 even on success.
    execFile('explorer.exe', [target]).unref();
    return;
  }
  return run('xdg-open', [target]);
}

function safeName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || 'model';
}

function allowed(req: IncomingMessage): boolean {
  if (!LOCAL.test(req.socket.remoteAddress ?? '')) return false;
  if (req.headers['x-fabbrico'] !== '1') return false;
  const origin = req.headers.origin;
  return !origin || LOCAL_ORIGIN.test(origin);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error('File too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function localActions(): Plugin {
  return {
    name: 'fabbrico-local-actions',
    configureServer(server) {
      moveLegacyFolder();
      server.middlewares.use('/local-api', (req, res) => {
        if (!allowed(req)) return json(res, 403, { error: 'Only Fabbrico on this computer can do this' });
        const url = new URL(req.url ?? '/', 'http://x');
        const handle = async () => {
          if (url.pathname === '/library' || url.pathname.startsWith('/library/'))
            return handleLibrary(req, res, url, json, readBody, (target) => openWith(target, null));
          if (req.method === 'GET' && url.pathname === '/info') {
            return json(res, 200, {
              exportDir: exportDir(),
              slicers: SLICERS.filter((s) => slicerPath(s)).map(({ id, name }) => ({ id, name })),
            });
          }
          if (req.method === 'POST' && url.pathname === '/open-folder') {
            await mkdir(exportDir(), { recursive: true });
            await openWith(exportDir(), null);
            return json(res, 200, { ok: true });
          }
          if (req.method === 'POST' && url.pathname === '/export') {
            const format = url.searchParams.get('format');
            if (format !== '3mf' && format !== 'stl') return json(res, 400, { error: 'Unknown format' });
            const slicerId = url.searchParams.get('open');
            const slicer = slicerId ? SLICERS.find((s) => s.id === slicerId) : undefined;
            const app = slicer ? slicerPath(slicer) : null;
            if (slicerId && !app) return json(res, 404, { error: `${slicer?.name ?? 'That slicer'} is not installed` });
            const bytes = await readBody(req);
            await mkdir(exportDir(), { recursive: true });
            const file = join(exportDir(), `${safeName(url.searchParams.get('name') ?? '')}.${format}`);
            await writeFile(file, bytes);
            if (app) await openWith(file, app);
            return json(res, 200, { file });
          }
          json(res, 404, { error: 'Not found' });
        };
        handle().catch((e: Error) => json(res, 500, { error: e.message }));
      });
    },
  };
}
