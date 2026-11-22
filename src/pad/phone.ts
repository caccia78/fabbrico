// Fabbrico on a phone: no tracing (the screen is too small to trace objects on),
// but the camera and a quick way to send measurements, plus an AR preview of
// the plate at real size.

import './pad.css';
import { FEATURES, handleReply, pickAndSendPhotos, reportOutcome, requestAr, switchKind, writeAndSendNote, type Link } from './device';

const TOKEN_KEY = 'fabbrico.pad.token';

function token(): string | null {
  const m = (location.search + location.hash).match(/[?#&]t=([A-Za-z0-9_-]{16,64})/);
  if (m) {
    try {
      localStorage.setItem(TOKEN_KEY, m[1]);
    } catch {
      /* ignore */
    }
    return m[1];
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

// Same theme choice as the tablet page.
try {
  document.documentElement.dataset.theme = localStorage.getItem('fabbrico.pad.theme') || 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

document.title = 'Fabbrico Phone';
document.body.classList.add('phone');
document.body.innerHTML = `
  <header>
    <span id="status" class="dot"></span>
    <b>Fabbrico · Phone</b>
    <span class="spacer"></span>
  </header>
  <main class="phone-main">
    <p id="conn" class="phone-conn muted"></p>
    <button id="photo" class="big"><span class="ico">📷</span><span><b>Photo</b><small>Take or choose photos of the real object</small></span></button>
    <button id="note" class="big"><span class="ico">📝</span><span><b>Measurement note</b><small>Sizes taken with a caliper, for the AI</small></span></button>
    <button id="outcome" class="big"><span class="ico">🧪</span><span><b>Print outcome</b><small>How a print went, with photos, for the project diary</small></span></button>
    <button id="ar" class="big"><span class="ico">🧊</span><span><b>View in AR</b><small>The plate open in Fabbrico, at real size on your table</small></span></button>
    <section class="phone-info">
      <h4>On this phone</h4>
      <ul>${FEATURES.phone.map((f) => `<li>✓ ${f}</li>`).join('')}</ul>
      <p class="muted">Tracing objects needs a <b>tablet</b> (iPad with Apple Pencil): open the same QR code there.</p>
      <button id="switch" class="link">This is a tablet? Use the tablet page</button>
    </section>
  </main>
  <div id="toast" class="toast"></div>`;

const $ = (id: string) => document.getElementById(id)!;

function toast(text: string, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => t.classList.remove('show'), ms);
}

let ws: WebSocket | null = null;
let hostOnline = false;

function refresh() {
  $('status').className = `dot ${hostOnline ? 'on' : ''}`;
  $('conn').textContent = hostOnline ? 'Connected to Fabbrico' : 'Waiting for Fabbrico… (open Fabbrico on the computer)';
  for (const id of ['photo', 'note', 'outcome', 'ar']) ($(id) as HTMLButtonElement).disabled = !hostOnline;
}

const link: Link = {
  send: (msg) => {
    if (!hostOnline || ws?.readyState !== WebSocket.OPEN) {
      toast('Fabbrico is not connected: open Fabbrico on the computer');
      return false;
    }
    ws.send(JSON.stringify(msg));
    return true;
  },
  toast,
};

function connect(tok: string) {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pad-ws?role=pad&kind=phone&token=${tok}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; fabbrico?: boolean; id?: string };
    if (msg.type === 'status') {
      hostOnline = !!msg.fabbrico;
      refresh();
    } else handleReply(msg, link);
  };
  ws.onclose = () => {
    hostOnline = false;
    refresh();
    setTimeout(() => connect(tok), 2000);
  };
}

$('photo').onclick = () => pickAndSendPhotos(link, 'phone');
$('note').onclick = () => writeAndSendNote(link, 'phone');
$('ar').onclick = () => requestAr(link, 'phone');
$('outcome').onclick = () => reportOutcome(link, 'phone');
$('switch').onclick = () => switchKind('tablet');

refresh();
const tok = token();
if (!tok) toast('Open this page by scanning the QR code in Fabbrico (Devices button).', 100000);
else connect(tok);
