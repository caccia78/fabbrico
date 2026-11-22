// Screenshot of Fabbrico with a demo scene, for the README and the website.
// Needs Fabbrico running (npm start) and Google Chrome. It uses a throw-away headless
// Chrome profile and fakes the Claude Code bridge and the tablet relay, so the
// real ones are not touched.
//
// Usage: node scripts/screenshot.mjs docs/images/screenshot.png [width] [height]
// Env: WAIT (ms to let the geometry build, default 20000), ZOOM (wheel steps out, default 12),
//      FABBRICO_URL (default http://localhost:5173), CHROME (path to the Chrome binary).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const [out, W = '1440', H = '900'] = process.argv.slice(2);
const T = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
const at = (x, y, z = 0) => ({ position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] });
let n = 0;
const node = (name, color, shape, extra = {}) => ({ id: `demo${n++}`, name, color, hole: false, transform: T(), shape, modifiers: [], ...extra });
const star = [];
for (let i = 0; i < 12; i++) { const a = (i * Math.PI) / 6, r = i % 2 ? 22 : 30; star.push([+(r * Math.cos(a)).toFixed(2), +(r * Math.sin(a)).toFixed(2)]); }
const nodes = [
  node('Pen cup', '#4f8cff', { kind: 'group', op: 'union', children: [
    node('Body', '#4f8cff', { kind: 'cylinder', radius: 32, radiusTop: 32, height: 90, segments: 0 }, {
      modifiers: [
                  { type: 'chamfer', size: 1, edges: 'top' }] }),
    node('Inside', '#888888', { kind: 'cylinder', radius: 28, radiusTop: 28, height: 90, segments: 0 }, { hole: true, transform: at(0, 0, 3) }),
  ] }, { transform: at(-60, 10) }),
  node('Twisted vase', '#ff9f43', { kind: 'polygon', points: star, height: 110, twist: 90, scaleTop: 0.8 }, { transform: at(30, 15) }),
  node('Name tag', '#2ed47a', { kind: 'group', op: 'union', children: [
    node('Plate', '#2ed47a', { kind: 'box', size: [80, 26, 5] }, { modifiers: [{ type: 'chamfer', size: 1, edges: 'top' }] }),
    node('Label', '#2ed47a', { kind: 'text', text: 'Fabbrico', font: 'sans-bold', size: 9, height: 1.2, align: 'center' }, { transform: at(0, 0, 4.8) }),
  ] }, { transform: at(-15, -60) }),
];
const profile = mkdtempSync(join(tmpdir(), 'fabbrico-shot-'));
const chrome = spawn(process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  // Stand-in for the Claude Code bridge and the tablet relay: shows "connected" without touching the real ones.
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (!/:5180|pad-ws/.test(String(url))) return new Real(url, p);
    const fake = { readyState: 1, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
    if (/:5180/.test(String(url))) setTimeout(() => fake.onopen && fake.onopen({}), 50);
    return fake;
  };
  window.WebSocket.OPEN = 1; window.WebSocket.CLOSED = 3; window.WebSocket.CONNECTING = 0; window.WebSocket.CLOSING = 2;
` });
await send('Page.navigate', { url: process.env.FABBRICO_URL ?? 'http://localhost:5173/' });
await sleep(2500);
const plates = { plates: [{ id: 'demoplate', name: 'Desk set', nodes }], active: 'demoplate' };
await evalJs(`localStorage.setItem('fabbrico.plates', ${JSON.stringify(JSON.stringify(plates))}); localStorage.setItem('fabbrico.project', JSON.stringify({ name: 'Desk set', dirty: false })); true`);
await send('Page.reload');
await sleep(Number(process.env.WAIT ?? 20000));
for (let i = 0; i < Number(process.env.ZOOM ?? 12); i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(W) / 2, y: Number(H) / 2, deltaX: 0, deltaY: 400 }); await sleep(80); }
await sleep(1500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
ws.close();
chrome.kill();
setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000);
