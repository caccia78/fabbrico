// Fabbrico Pad: a drawing page for a tablet (iPad + Apple Pencil) on the same
// network as Fabbrico. Place an object on the screen, trace around it with the
// pencil, send the tracing to Fabbrico. Strokes are kept in millimetres.
// Sketch mode: a free sheet to draw a part with its dimensions written by
// hand; Fabbrico keeps it as a picture the AI models from (shape assist: hold the
// pencil still at the end of a stroke to straighten it, see shapes.ts).
// Also photos, notes and AR preview, shared with the phone page (device.ts).

import './pad.css';
import { handleReply, pickAndSendPhotos, requestAr, writeAndSendNote, type Link } from './device';
import { detectScale, resetCalibration, saveCalibration, type ScaleInfo } from './scale';
import { VIEWS, VIEW_HINTS } from '../tablet/views';
import { recognize } from './shapes';

type Stroke = number[]; // x0, y0, x1, y1… in mm, y down (screen)

const LABELS = VIEWS;
const TOKEN_KEY = 'fabbrico.pad.token';

// ------------------------------------------------------------------ state ----

let scale: ScaleInfo = detectScale();
let strokes: Stroke[] = [];
let current: Stroke | null = null;
let fingerMode = false;
let penSeen = false;
let hostOnline = false;
let label: (typeof LABELS)[number] = 'top';

/** Trace: draw around a real object at true scale. Sketch: draw a part with written dimensions. */
type Mode = 'trace' | 'sketch';
let mode: Mode = (() => {
  try {
    return localStorage.getItem('fabbrico.pad.drawmode') === 'sketch' ? 'sketch' : 'trace';
  } catch {
    return 'trace';
  }
})();
const newSketchId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The sketch is kept on this device until cleared; its id lets Fabbrico replace it when sent again. */
let sketch: { id: string; strokes: Stroke[] } = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('fabbrico.pad.sketch') ?? 'null') as { id: string; strokes: Stroke[] } | null;
    if (v && typeof v.id === 'string' && Array.isArray(v.strokes)) return v;
  } catch {
    /* ignore */
  }
  return { id: newSketchId(), strokes: [] };
})();
function saveSketch() {
  if (mode !== 'sketch') return;
  sketch.strokes = strokes;
  try {
    localStorage.setItem('fabbrico.pad.sketch', JSON.stringify(sketch));
  } catch {
    /* full: it stays on screen anyway */
  }
}

function token(): string | null {
  // The pairing code stays in the address (?t=…): "Add to Home Screen" saves the
  // address, and the home-screen app doesn't share Safari's storage.
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

// --------------------------------------------------------------------- UI ----

document.body.innerHTML = `
  <header>
    <span id="status" class="dot"></span>
    <b>Fabbrico · Tablet</b>
    <span class="seg" id="mode">
      <button data-mode="trace" title="Trace around a real object, at true scale">Trace</button>
      <button data-mode="sketch" title="Sketch a part and write its dimensions: the AI models it">Sketch</button>
    </span>
    <span class="picker" id="picker">
      <button id="label" title="Which side of the object is facing up"></button>
      <span id="label-menu" class="menu" hidden>
        ${LABELS.map((l) => `<button data-label="${l}">${l}</button>`).join('')}
      </span>
    </span>
    <span class="spacer"></span>
    <button id="photo" title="Take or choose photos for the project (reference photos the AI can look at)">📷</button>
    <button id="note" title="Send a note to the project, e.g. measurements taken with a caliper">📝</button>
    <button id="ar" title="View the plate open in Fabbrico in AR, at real size">🧊</button>
    <button id="theme" title="Theme"></button>
    <button id="finger" title="Draw with a finger (when you have no pencil)">✋</button>
    <button id="scale" title="Check the scale"></button>
    <button id="undo">Undo</button>
    <button id="clear">Clear</button>
    <button id="send" class="primary">Send to Fabbrico</button>
  </header>
  <div id="hint" class="hint"></div>
  <main>
    <canvas id="canvas"></canvas>
    <nav id="tools">
      <div id="grip" title="Drag to move the tool bar">⠿</div>
      <button data-tool="pen" title="Draw">✏️<span>Pen</span></button>
      <button data-tool="erase-line" title="Tap or rub a line to delete all of it">⌫<span>Erase line</span></button>
      <button data-tool="erase-part" title="Rub to erase only where the eraser passes"><i class="circle-icon"></i><span>Erase part</span></button>
      <div class="zoom">
        <button id="zoom-out" title="Zoom out">−</button>
        <button id="zoom-in" title="Zoom in (or pinch with two fingers)">+</button>
      </div>
      <button id="zoom-level" title="Back to 100% (true scale)">100%</button>
      <button id="lock" title="Lock the view: two fingers no longer zoom or move the sheet"></button>
      <div class="sizes">
        <button data-size="S" title="Small eraser">S</button>
        <button data-size="M" class="active" title="Medium eraser">M</button>
        <button data-size="L" title="Large eraser">L</button>
      </div>
    </nav>
  </main>
  <div id="toast"></div>
  <div id="calib" hidden>
    <div class="calib-box">
      <p>Hold a ruler (or a credit card, 85.6 mm wide) against the screen and adjust until the marks match.</p>
      <div id="ruler"></div>
      <div id="card"></div>
      <div class="row">
        <button id="minus">−</button>
        <input id="factor" type="range" min="0.9" max="1.1" step="0.001" value="1" />
        <button id="plus">+</button>
      </div>
      <div class="row">
        <button id="calib-reset">Use detected</button>
        <span class="spacer"></span>
        <button id="calib-cancel">Cancel</button>
        <button id="calib-ok" class="primary">Save</button>
      </div>
    </div>
  </div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;

function toast(text: string, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => t.classList.remove('show'), ms);
}

function refreshHeader() {
  $('status').className = `dot ${hostOnline ? 'on' : ''}`;
  $('status').title = hostOnline ? 'Connected to Fabbrico' : 'Fabbrico is not connected';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode [data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
  $('picker').hidden = mode === 'sketch';
  $('send').textContent = mode === 'sketch' ? 'Send sketch' : 'Send to Fabbrico';
  const s = $('scale');
  s.textContent = scale.sure ? '📏' : '📏 check scale';
  s.title = `${scale.source}: ${scale.mmPerPx.toFixed(4)} mm per point`;
  s.classList.toggle('warn', !scale.sure);
  s.hidden = mode === 'sketch';
  $('finger').classList.toggle('active', fingerMode);
  $('finger').hidden = penSeen && !fingerMode;
  ($('send') as HTMLButtonElement).disabled = !strokes.length;
  ($('undo') as HTMLButtonElement).disabled = !undoStack.length;
}

// ------------------------------------------------------------ rendering ----

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  draw();
}

/**
 * View: zoom k and pan (ox, oy) in CSS px. At k = 1 and no pan the drawing is
 * 1:1 with reality, which is what tracing needs; zooming is for detail work.
 */
const view = { k: 1, ox: 0, oy: 0 };
const pxPerMm = () => view.k / scale.mmPerPx;
const sx = (mm: number) => mm * pxPerMm() + view.ox;
const sy = (mm: number) => mm * pxPerMm() + view.oy;
const isTrueScale = () => view.k === 1 && view.ox === 0 && view.oy === 0;
let zoomWarned = false;
let viewLocked = (() => {
  try {
    return localStorage.getItem('fabbrico.pad.lock') === '1';
  } catch {
    return false;
  }
})();

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Theme: dark / light / same as the iPad, remembered on this device.
type Theme = 'dark' | 'light' | 'system';
let theme: Theme = (() => {
  try {
    return (localStorage.getItem('fabbrico.pad.theme') as Theme) || 'dark';
  } catch {
    return 'dark';
  }
})();
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const b = document.getElementById('theme');
  if (b) {
    b.textContent = theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐';
    b.title = `Theme: ${theme === 'system' ? 'same as iPad' : theme} (tap to change)`;
  }
  draw();
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => draw());

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const px = pxPerMm();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 10 mm grid (1 mm when zoomed in a lot), darker every 5 lines: shows the real scale.
  const w = canvas.width / dpr, h = canvas.height / dpr;
  const step = px * 10 > 120 ? 1 : 10;
  const first = (o: number) => Math.floor(-o / px / step) * step;
  for (const [axis, o, len, other] of [['x', view.ox, w, h], ['y', view.oy, h, w]] as const) {
    for (let mm = first(o); mm * px + o < len; mm += step) {
      const p = mm * px + o;
      ctx.strokeStyle = Math.round(mm / step) % 5 === 0 ? css('--grid-major') : css('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (axis === 'x') {
        ctx.moveTo(p, 0);
        ctx.lineTo(p, other);
      } else {
        ctx.moveTo(0, p);
        ctx.lineTo(other, p);
      }
      ctx.stroke();
    }
  }
  ctx.strokeStyle = css('--ink');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const st of current ? [...strokes, current] : strokes) {
    ctx.beginPath();
    for (let i = 0; i < st.length; i += 2) {
      const x = sx(st[i]), y = sy(st[i + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (st.length === 2) ctx.lineTo(sx(st[0]) + 0.1, sy(st[1]));
    ctx.stroke();
  }
  if (eraserAt) {
    ctx.strokeStyle = css('--eraser');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(sx(eraserAt[0]), sy(eraserAt[1]), ERASER_SIZES[eraserSize] * px, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const z = document.getElementById('zoom-level');
  if (z) {
    z.textContent = `${Math.round(view.k * 100)}%`;
    z.classList.toggle('warn', mode === 'trace' && !isTrueScale());
    z.title = mode === 'sketch' ? 'Back to 100%' : isTrueScale() ? 'True scale: 1 mm on screen = 1 mm' : 'Not at true scale: tap to go back to 100% before tracing';
  }
}

// -------------------------------------------------------------- drawing ----

type Tool = 'pen' | 'erase-line' | 'erase-part';
let tool: Tool = 'pen';
const ERASER_SIZES = { S: 1, M: 2.5, L: 5 } as const; // radius, mm
let eraserSize: keyof typeof ERASER_SIZES = 'M';
/** Eraser position while erasing or hovering (mm), for the cursor circle. */
let eraserAt: [number, number] | null = null;
/** Snapshots for Undo: drawing a line, an erasing gesture and Clear are one step each. */
let undoStack: Stroke[][] = [];
const snapshot = () => {
  undoStack.push(strokes.map((s) => s.slice()));
  if (undoStack.length > 100) undoStack.shift();
};

const accepts = (e: PointerEvent) => e.pointerType === 'pen' || (fingerMode && e.pointerType !== 'pen');
const toMm = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left - view.ox) / pxPerMm(), (e.clientY - r.top - view.oy) / pxPerMm()];
};
/** Pens with an eraser end or button (not the Apple Pencil) erase while it's held. */
const activeTool = (e: PointerEvent): Tool => (e.buttons & 32 ? 'erase-part' : tool);

function addPoint(e: PointerEvent) {
  const [x, y] = toMm(e);
  const s = current!;
  const n = s.length;
  // Skip points closer than 0.1 mm to the previous one.
  if (n >= 2 && Math.hypot(x - s[n - 2], y - s[n - 1]) < 0.1) return;
  s.push(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
}

// Shape assist (sketch mode): the pencil rests still for a moment at the end of a stroke.
let assistTimer = 0;
let snapped = false;
function armAssist() {
  clearTimeout(assistTimer);
  if (mode !== 'sketch') return;
  assistTimer = window.setTimeout(() => {
    if (!current || snapped) return;
    const shape = recognize(current);
    if (!shape) return;
    current = shape.stroke;
    snapped = true;
    draw();
  }, 550);
}

/** Distance from (px, py) to the segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Remove whole lines that pass within the eraser. */
function eraseLines(x: number, y: number, r: number) {
  strokes = strokes.filter((s) => {
    if (s.length === 2) return Math.hypot(s[0] - x, s[1] - y) > r;
    for (let i = 2; i < s.length; i += 2) if (segDist(x, y, s[i - 2], s[i - 1], s[i], s[i + 1]) <= r) return false;
    return true;
  });
}

/** Remove only the parts of the lines under the eraser, splitting them where they're cut. */
function eraseParts(x: number, y: number, r: number) {
  const out: Stroke[] = [];
  const step = r / 3;
  for (const s of strokes) {
    // Quick reject: nothing near the eraser.
    let near = false;
    for (let i = 0; i < s.length && !near; i += 2) {
      if (i === 0 ? Math.hypot(s[0] - x, s[1] - y) <= r : segDist(x, y, s[i - 2], s[i - 1], s[i], s[i + 1]) <= r) near = true;
    }
    if (!near) {
      out.push(s);
      continue;
    }
    // Densify, so a long segment crossing the eraser is cut exactly there.
    const dense: number[] = [s[0], s[1]];
    for (let i = 2; i < s.length; i += 2) {
      const ax = s[i - 2], ay = s[i - 1], bx = s[i], by = s[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 1; k <= n; k++) dense.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    }
    let piece: number[] = [];
    for (let i = 0; i < dense.length; i += 2) {
      if (Math.hypot(dense[i] - x, dense[i + 1] - y) <= r) {
        if (piece.length >= 4) out.push(piece);
        piece = [];
      } else piece.push(Math.round(dense[i] * 1000) / 1000, Math.round(dense[i + 1] * 1000) / 1000);
    }
    if (piece.length >= 4) out.push(piece);
  }
  strokes = out;
}

let erasing = false;
function eraseAt(e: PointerEvent) {
  const [x, y] = toMm(e);
  eraserAt = [x, y];
  const r = ERASER_SIZES[eraserSize];
  if (activeTool(e) === 'erase-line') eraseLines(x, y, r);
  else eraseParts(x, y, r);
}

// Two fingers pinch to zoom and drag to pan (fingers don't draw unless ✋ is on).
const touches = new Map<number, [number, number]>();
let gesture: { k: number; ox: number; oy: number; cx: number; cy: number; d: number } | null = null;
const local = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
function gestureStart() {
  const [a, b] = [...touches.values()];
  gesture = { ...view, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 };
}
function gestureMove() {
  if (!gesture || touches.size < 2) return;
  const [a, b] = [...touches.values()];
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const k = Math.min(8, Math.max(0.25, (gesture.k * Math.hypot(a[0] - b[0], a[1] - b[1])) / gesture.d));
  // Keep the point under the fingers' centre under the fingers.
  const mx = (gesture.cx - gesture.ox) / gesture.k, my = (gesture.cy - gesture.oy) / gesture.k;
  setView(k, cx - mx * k, cy - my * k);
}
function setView(k: number, ox: number, oy: number) {
  // Snap to true scale when close, so it's easy to get back to 1:1 by pinching.
  if (Math.abs(k - 1) < 0.04 && Math.hypot(ox, oy) < 12) [k, ox, oy] = [1, 0, 0];
  if (k === 1 && ox === 0 && oy === 0) zoomWarned = false;
  view.k = k;
  view.ox = ox;
  view.oy = oy;
  draw();
}
/** Zoom by a factor around the canvas centre (buttons). */
function zoomBy(f: number) {
  const r = canvas.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;
  const k = Math.min(8, Math.max(0.25, view.k * f));
  const mx = (cx - view.ox) / view.k, my = (cy - view.oy) / view.k;
  setView(k, cx - mx * k, cy - my * k);
}

// Palm rejection for gestures: a touch doesn't count while the pencil is on (or
// just left) the screen, or when more than two things touch at once (a hand
// resting). Safari reports finger contacts as big as a palm, so size can't be
// used. The lock turns gestures off altogether.
let penDown = false;
let penUpAt = 0;
const isPalm = () => viewLocked || penDown || performance.now() - penUpAt < 1500;
function cancelGesture() {
  gesture = null;
  touches.clear();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') {
    penDown = true;
    if (gesture) cancelGesture(); // the pencil wins over a gesture that a palm may have started
  }
  if (e.pointerType === 'touch') {
    if (isPalm() || touches.size >= 2) {
      if (touches.size >= 2) cancelGesture(); // a third contact: that's a hand resting, not a pinch
      return;
    }
    touches.set(e.pointerId, local(e));
    canvas.setPointerCapture(e.pointerId);
    if (touches.size === 2) {
      // A second finger: it's a gesture, not drawing. Drop a line just started with a finger.
      if (current && fingerMode) current = null;
      if (erasing && fingerMode) {
        erasing = false;
        const prev = undoStack.pop();
        if (prev) strokes = prev;
      }
      gestureStart();
      draw();
      return;
    }
    if (!fingerMode) return;
  }
  if (e.pointerType === 'pen' && !penSeen) {
    penSeen = true;
    fingerMode = false;
    refreshHeader();
  }
  if (!accepts(e)) return; // palm, or the object resting on the screen
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  if (activeTool(e) === 'pen') {
    if (mode === 'trace' && !isTrueScale() && !zoomWarned) {
      zoomWarned = true;
      toast('Zoomed in: fine for drawing, but to trace an object go back to 100% (true scale)', 4000);
    }
    current = [];
    snapped = false;
    addPoint(e);
    armAssist();
  } else {
    snapshot();
    erasing = true;
    eraseAt(e);
  }
  draw();
  refreshHeader();
});
/** The finer points of a move; some browsers give an empty list, then the event itself. */
const coalesced = (e: PointerEvent) => {
  const list = e.getCoalescedEvents?.();
  return list?.length ? list : [e];
};
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, local(e));
    if (gesture) return gestureMove();
  }
  if (!accepts(e)) return;
  if (current) {
    if (snapped) return; // a clean shape: stays as it is until the pencil lifts
    const n = current.length;
    for (const ev of coalesced(e)) addPoint(ev);
    if (current.length !== n) armAssist();
  } else if (erasing) {
    for (const ev of coalesced(e)) eraseAt(ev);
  } else if (tool !== 'pen' || e.buttons & 32) {
    eraserAt = toMm(e); // Pencil hovering over the screen: show where the eraser is
  } else return;
  draw();
});
canvas.addEventListener('pointerleave', () => {
  if (!erasing && eraserAt) {
    eraserAt = null;
    draw();
  }
});
const end = (e: PointerEvent) => {
  if (e.pointerType === 'pen') {
    penDown = false;
    penUpAt = performance.now();
  }
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (gesture) {
      if (touches.size < 2) gesture = null;
      return;
    }
  }
  if (!accepts(e)) return;
  clearTimeout(assistTimer);
  if (current) {
    if (current.length >= 2) {
      snapshot();
      strokes.push(current);
    }
    current = null;
  }
  saveSketch();
  if (erasing) {
    erasing = false;
    if (e.pointerType !== 'pen') eraserAt = null; // a finger doesn't hover
  }
  draw();
  refreshHeader();
};
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
// Stop Safari from scrolling or zooming while drawing.
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

function setTool(t: Tool) {
  tool = t;
  eraserAt = null;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tools [data-size]')) b.hidden = t === 'pen';
  draw();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]')) b.onclick = () => setTool(b.dataset.tool as Tool);
for (const b of document.querySelectorAll<HTMLButtonElement>('#tools [data-size]'))
  b.onclick = () => {
    eraserSize = b.dataset.size as keyof typeof ERASER_SIZES;
    for (const o of document.querySelectorAll<HTMLButtonElement>('#tools [data-size]')) o.classList.toggle('active', o === b);
  };
setTool('pen');

$('theme').onclick = () => {
  theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  try {
    localStorage.setItem('fabbrico.pad.theme', theme);
  } catch {
    /* ignore */
  }
  applyTheme();
};
applyTheme();

$('zoom-in').onclick = () => zoomBy(1.5);
$('zoom-out').onclick = () => zoomBy(1 / 1.5);
$('zoom-level').onclick = () => setView(1, 0, 0);
function showLock() {
  $('lock').textContent = viewLocked ? '🔒' : '🔓';
  $('lock').classList.toggle('active', viewLocked);
}
$('lock').onclick = () => {
  viewLocked = !viewLocked;
  try {
    localStorage.setItem('fabbrico.pad.lock', viewLocked ? '1' : '0');
  } catch {
    /* ignore */
  }
  cancelGesture();
  showLock();
  toast(viewLocked ? 'View locked: the sheet stays put' : 'View unlocked: pinch to zoom');
};
showLock();

// Move the tool bar by its grip; the place is remembered.
{
  const nav = $('tools');
  const grip = $('grip');
  const place = (x: number, y: number) => {
    const main = nav.parentElement!.getBoundingClientRect();
    const x2 = Math.min(Math.max(0, x), main.width - nav.offsetWidth);
    const y2 = Math.min(Math.max(0, y), main.height - nav.offsetHeight);
    nav.style.left = `${x2}px`;
    nav.style.top = `${y2}px`;
    return [x2, y2];
  };
  try {
    const saved = JSON.parse(localStorage.getItem('fabbrico.pad.tools') ?? 'null') as [number, number] | null;
    if (saved) requestAnimationFrame(() => place(saved[0], saved[1]));
  } catch {
    /* ignore */
  }
  let drag: { dx: number; dy: number } | null = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = nav.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const main = nav.parentElement!.getBoundingClientRect();
    place(e.clientX - main.left - drag.dx, e.clientY - main.top - drag.dy);
  });
  const stop = () => {
    if (!drag) return;
    drag = null;
    try {
      localStorage.setItem('fabbrico.pad.tools', JSON.stringify([parseFloat(nav.style.left), parseFloat(nav.style.top)]));
    } catch {
      /* ignore */
    }
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
  window.addEventListener('resize', () => place(nav.offsetLeft, nav.offsetTop));
}

// Pencil taps on buttons: make sure they act even where Safari doesn't turn
// a pencil tap into a click, without acting twice where it does.
{
  let penPressed: HTMLButtonElement | null = null;
  let penClicked: { el: Element; at: number } | null = null;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'pen') return;
      penPressed = (e.target as Element).closest('button');
      // Tapping outside an open menu closes it.
      if (!(e.target as Element).closest('.picker')) $('label-menu').hidden = true;
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType !== 'pen' || !penPressed) return;
      const btn = (e.target as Element).closest('button');
      if (btn && btn === penPressed && !btn.disabled) {
        penClicked = { el: btn, at: performance.now() };
        btn.click();
      }
      penPressed = null;
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      // The browser's own click right after ours: drop it.
      if (e.isTrusted && penClicked && performance.now() - penClicked.at < 500 && (e.target as Element).closest('button') === penClicked.el) {
        e.stopImmediatePropagation();
        e.preventDefault();
        penClicked = null;
      }
    },
    true,
  );
}

$('undo').onclick = () => {
  const prev = undoStack.pop();
  if (!prev) return;
  strokes = prev;
  saveSketch();
  draw();
  refreshHeader();
};
$('clear').onclick = () => {
  if (!strokes.length) return;
  snapshot(); // Undo brings it back
  strokes = [];
  if (mode === 'sketch') {
    sketch.id = newSketchId(); // a new sketch in Fabbrico from now on
    saveSketch();
  }
  draw();
  refreshHeader();
  toast(mode === 'sketch' ? 'New sketch (Undo brings the old one back)' : 'Cleared (Undo brings it back)');
};
$('finger').onclick = () => {
  fingerMode = !fingerMode;
  toast(fingerMode ? 'Drawing with a finger' : 'Drawing with the pencil only');
  refreshHeader();
};
$('label').onclick = () => ($('label-menu').hidden = !$('label-menu').hidden);
for (const b of document.querySelectorAll<HTMLButtonElement>('#label-menu [data-label]'))
  b.onclick = () => {
    label = b.dataset.label as typeof label;
    $('label-menu').hidden = true;
    showHint();
  };
function showHint() {
  $('label').innerHTML = `<span class="muted">View</span> <b>${label}</b> ▾`;
  $('hint').textContent =
    mode === 'sketch'
      ? 'Sketch the part with its dimensions in mm, all the views you need on one sheet. Hold the pencil still at the end of a stroke to straighten a line, circle or rectangle.'
      : `Place the object ${VIEW_HINTS[label]}.`;
}

/** Each mode has its own drawing and undo history. */
let traceDoc: { strokes: Stroke[]; undo: Stroke[][] } = { strokes: [], undo: [] };
let sketchUndo: Stroke[][] = [];
function setMode(m: Mode) {
  if (m === mode) return;
  if (mode === 'trace') traceDoc = { strokes, undo: undoStack };
  else {
    saveSketch();
    sketchUndo = undoStack;
  }
  mode = m;
  [strokes, undoStack] = m === 'sketch' ? [sketch.strokes, sketchUndo] : [traceDoc.strokes, traceDoc.undo];
  try {
    localStorage.setItem('fabbrico.pad.drawmode', m);
  } catch {
    /* ignore */
  }
  if (m === 'trace' && !isTrueScale()) setView(1, 0, 0); // tracing needs true scale
  showHint();
  draw();
  refreshHeader();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#mode [data-mode]')) b.onclick = () => setMode(b.dataset.mode as Mode);
if (mode === 'sketch') strokes = sketch.strokes;
showHint();

// ----------------------------------------------------------- calibration ----

let factor = 1;
function drawCalibration() {
  const px = 1 / (scale.mmPerPx * factor);
  const ruler = $('ruler');
  ruler.style.width = `${100 * px}px`;
  ruler.innerHTML = Array.from({ length: 11 }, (_, i) => `<i style="left:${i * 10 * px}px"><span>${i}</span></i>`).join('');
  const card = $('card');
  card.style.width = `${85.6 * px}px`;
  card.style.height = `${53.98 * px}px`;
}
$('scale').onclick = () => {
  factor = 1;
  ($('factor') as HTMLInputElement).value = '1';
  $('calib').hidden = false;
  drawCalibration();
};
($('factor') as HTMLInputElement).oninput = (e) => {
  factor = Number((e.target as HTMLInputElement).value);
  drawCalibration();
};
$('minus').onclick = () => {
  factor = Math.max(0.9, factor - 0.002);
  ($('factor') as HTMLInputElement).value = String(factor);
  drawCalibration();
};
$('plus').onclick = () => {
  factor = Math.min(1.1, factor + 0.002);
  ($('factor') as HTMLInputElement).value = String(factor);
  drawCalibration();
};
$('calib-cancel').onclick = () => ($('calib').hidden = true);
$('calib-reset').onclick = () => {
  scale = resetCalibration();
  $('calib').hidden = true;
  toast(`Scale: ${scale.source}`);
  draw();
  refreshHeader();
};
$('calib-ok').onclick = () => {
  scale = saveCalibration(scale.mmPerPx * factor);
  $('calib').hidden = true;
  toast('Scale saved');
  draw();
  refreshHeader();
};

// --------------------------------------------------------------- network ----

let ws: WebSocket | null = null;
const pending = new Map<string, Stroke[]>();

function connect(tok: string) {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pad-ws?role=pad&kind=tablet&token=${tok}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; fabbrico?: boolean; id?: string; error?: string };
    if (msg.type === 'status') {
      hostOnline = !!msg.fabbrico;
      refreshHeader();
    } else if ((msg.type === 'ack' || msg.type === 'nack') && msg.id && sketchPending.delete(msg.id)) {
      toast(msg.type === 'ack' ? 'Sketch in Fabbrico ✓ (Files tab). Change it and send again to update it.' : `Fabbrico: ${msg.error ?? 'error'}`, 4000);
    } else if (msg.type === 'ack' && msg.id && pending.has(msg.id)) {
      pending.delete(msg.id);
      toast('Received by Fabbrico ✓');
    } else handleReply(msg, link);
  };
  ws.onclose = () => {
    hostOnline = false;
    refreshHeader();
    setTimeout(() => connect(tok), 2000);
  };
}

/** The sketch as a picture: white sheet, dark ink, cropped to the drawing. */
function renderSketch(list: Stroke[]): string {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const st of list)
    for (let i = 0; i < st.length; i += 2) {
      x0 = Math.min(x0, st[i]);
      x1 = Math.max(x1, st[i]);
      y0 = Math.min(y0, st[i + 1]);
      y1 = Math.max(y1, st[i + 1]);
    }
  const pad = 5; // mm
  x0 -= pad;
  y0 -= pad;
  const w = x1 + pad - x0, h = y1 + pad - y0;
  const k = Math.min(1600 / Math.max(w, h), 12); // px per mm
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#111';
  g.lineWidth = Math.max(2, 0.5 * k);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const st of list) {
    g.beginPath();
    for (let i = 0; i < st.length; i += 2) {
      const x = (st[i] - x0) * k, y = (st[i + 1] - y0) * k;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    if (st.length === 2) g.lineTo((st[0] - x0) * k + 0.5, (st[1] - y0) * k);
    g.stroke();
  }
  return c.toDataURL('image/jpeg', 0.9);
}

function sendSketch() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const stamp = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const sent = link.send({
    type: 'sketch',
    id,
    sketchId: sketch.id,
    name: `Sketch ${stamp}`,
    image: renderSketch(strokes),
    strokes: strokes.map((st) => st.map((v) => Math.round(v * 10) / 10)),
    from: 'tablet',
  });
  if (!sent) return;
  // The sketch stays here: change it and send again to update the same sketch in Fabbrico.
  sketchPending.set(id, true);
  setTimeout(() => {
    if (sketchPending.delete(id)) toast('Fabbrico did not confirm the sketch: try again', 5000);
  }, 15000);
  toast('Sending the sketch…', 15000);
}
const sketchPending = new Map<string, true>();

$('send').onclick = () => {
  if (!strokes.length) return;
  if (mode === 'sketch') return sendSketch();
  if (!hostOnline || ws?.readyState !== WebSocket.OPEN) {
    toast('Fabbrico is not connected: open Fabbrico on the computer (Devices button)');
    return;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const r = canvas.getBoundingClientRect();
  ws.send(
    JSON.stringify({
      type: 'tracing',
      id,
      label,
      // y up (like Fabbrico), relative to the screen's top-left corner
      strokes: strokes.map((s) => s.map((v, i) => (i % 2 ? -v : v))),
      area: [r.width * scale.mmPerPx, r.height * scale.mmPerPx],
      device: { scale: scale.source, mmPerPx: scale.mmPerPx, pen: penSeen },
    }),
  );
  pending.set(id, strokes);
  // Not confirmed in a few seconds: give the drawing back so nothing is lost.
  setTimeout(() => {
    const lost = pending.get(id);
    if (!lost) return;
    pending.delete(id);
    strokes = [...lost, ...strokes];
    draw();
    refreshHeader();
    toast('Fabbrico did not confirm: the drawing is back, try again');
  }, 6000);
  strokes = [];
  draw();
  refreshHeader();
  toast('Sent…');
};

// ------------------------------------------- photos, notes, AR (device.ts) ----

const link: Link = {
  send: (msg) => {
    if (!hostOnline || ws?.readyState !== WebSocket.OPEN) {
      toast('Fabbrico is not connected: open Fabbrico on the computer (Devices button)');
      return false;
    }
    ws.send(JSON.stringify(msg));
    return true;
  },
  toast,
};
$('photo').onclick = () => pickAndSendPhotos(link, 'tablet');
$('note').onclick = () => writeAndSendNote(link, 'tablet');
$('ar').onclick = () => requestAr(link, 'tablet');

// ------------------------------------------------------------------ start ----

const tok = token();
window.addEventListener('resize', resize);
resize();
refreshHeader();
if (!tok) {
  toast('Open this page by scanning the QR code in Fabbrico (Devices button).', 100000);
} else {
  connect(tok);
  if (!scale.sure) toast('Unknown screen: tap 📏 to check the scale before tracing.', 6000);
}
