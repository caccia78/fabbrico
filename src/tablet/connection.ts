// Fabbrico's side of the tablet link (see server/padRelay.ts and src/pad/).
// Keeps a pairing token, stays connected to the relay as "host", and collects
// incoming tracings in an inbox until the user turns them into objects.

import { create } from 'zustand';

import { VIEWS, type View } from './views';
import { addNote, addPhoto } from '../model/references';
import { makeArPreview } from './ar';
import { addAttemptPhoto, OUTCOMES, setOutcome, useDiary, type OutcomeResult } from '../model/diary';

export interface Tracing {
  id: string;
  /** Which side of the object faced up while tracing (= the view it shows). */
  label: View;
  /** Strokes, flat x,y pairs in mm, y up. */
  strokes: number[][];
  receivedAt: number;
  device?: { scale?: string; mmPerPx?: number; pen?: boolean };
}

export type DeviceKind = 'tablet' | 'phone';

interface TabletState {
  /** Connected to the relay (Fabbrico is served by the dev server with the relay). */
  online: boolean;
  /** Number of devices currently connected. */
  pads: number;
  /** Kind of each connected device. */
  devices: DeviceKind[];
  inbox: Tracing[];
  /** Most recent arrival, to flash the button. */
  lastArrival: number;
}

const TOKEN_KEY = 'fabbrico.tablet.token';
const INBOX_KEY = 'fabbrico.tablet.inbox';

function loadInbox(): Tracing[] {
  try {
    return JSON.parse(localStorage.getItem(INBOX_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export const useTablet = create<TabletState>(() => ({ online: false, pads: 0, devices: [], inbox: loadInbox(), lastArrival: 0 }));

useTablet.subscribe((s, prev) => {
  if (s.inbox === prev.inbox) return;
  try {
    localStorage.setItem(INBOX_KEY, JSON.stringify(s.inbox));
  } catch {
    /* ignore: the inbox still works for this session */
  }
});

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pairingToken(): string {
  try {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      t = randomToken();
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch {
    return (pairingToken as unknown as { mem?: string }).mem ??= randomToken();
  }
}

/** Forget the current pairing: tablets that had the old code are cut off. */
export function newPairingToken() {
  try {
    localStorage.setItem(TOKEN_KEY, randomToken());
  } catch {
    /* ignore */
  }
  ws?.close();
}

export function removeTracing(id: string) {
  useTablet.setState((s) => ({ inbox: s.inbox.filter((t) => t.id !== id) }));
}

/** Delete several tracings, or all of them when `ids` is omitted. */
export function removeTracings(ids?: Set<string>) {
  useTablet.setState((s) => ({ inbox: ids ? s.inbox.filter((t) => !ids.has(t.id)) : [] }));
}

export function setTracingLabel(id: string, label: View) {
  useTablet.setState((s) => ({ inbox: s.inbox.map((t) => (t.id === id ? { ...t, label } : t)) }));
}

/** LAN address of this computer for the tablet, from the dev server. */
export async function padUrl(): Promise<{ url: string; addresses: string[] } | null> {
  try {
    const res = await fetch('/pad-api/info');
    if (!res.ok) return null;
    const info = (await res.json()) as { addresses: string[]; port: number };
    if (!info.addresses.length) return { url: '', addresses: [] };
    const make = (a: string) => `http://${a}:${info.port}/pad.html?t=${pairingToken()}`;
    return { url: make(info.addresses[0]), addresses: info.addresses.map(make) };
  } catch {
    return null;
  }
}

let ws: WebSocket | null = null;
let started = false;

/** Connect to the relay and keep reconnecting. Does nothing useful when Fabbrico isn't served by the dev server. */
export function startTablet() {
  if (started) return;
  started = true;
  let delay = 1000;
  const connect = () => {
    const token = pairingToken();
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pad-ws?role=host&token=${token}`);
    ws.onopen = () => {
      delay = 1000;
      useTablet.setState({ online: true });
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; connected?: number; devices?: unknown; image?: unknown; name?: unknown; text?: unknown; from?: unknown; sketchId?: unknown; attemptId?: unknown; result?: unknown; note?: unknown; photos?: unknown } & Partial<Tracing>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'pad') {
        const devices = Array.isArray(msg.devices) ? msg.devices.map((d): DeviceKind => (d === 'phone' ? 'phone' : 'tablet')) : [];
        useTablet.setState({ pads: msg.connected ?? 0, devices });
      }
      const from: DeviceKind = msg.from === 'phone' ? 'phone' : 'tablet';
      const reply = (m: object) => ws?.send(JSON.stringify(m));
      if (msg.type === 'note' && typeof msg.id === 'string' && typeof msg.text === 'string' && msg.text.trim()) {
        addNote(msg.text, { source: from });
        reply({ type: 'ack', id: msg.id });
      }
      // Print outcomes from the phone (project diary, experimental).
      if (msg.type === 'attempts-request' && typeof msg.id === 'string') {
        const list = [...useDiary.getState().attempts]
          .reverse()
          .slice(0, 10)
          .map((a) => ({ id: a.id, n: a.n, plate: a.plate, at: a.at, render: a.render, outcome: a.outcome?.result ?? null, note: a.outcome?.note ?? '' }));
        reply({ type: 'attempts', id: msg.id, list });
      }
      if (msg.type === 'outcome' && typeof msg.id === 'string' && typeof msg.attemptId === 'string' && OUTCOMES.includes(msg.result as OutcomeResult)) {
        const id = msg.id;
        const attempt = useDiary.getState().attempts.find((a) => a.id === msg.attemptId);
        if (!attempt) reply({ type: 'nack', id, error: 'That print is no longer in the diary' });
        else {
          setOutcome(attempt.id, { result: msg.result as OutcomeResult, note: typeof msg.note === 'string' ? msg.note : '', source: from === 'phone' ? 'phone' : 'fabbrico' });
          const photos = Array.isArray(msg.photos) ? msg.photos.filter((p): p is string => typeof p === 'string' && p.startsWith('data:image/')).slice(0, 6) : [];
          void (async () => {
            for (const p of photos) await addAttemptPhoto(attempt.id, await (await fetch(p)).blob());
          })().then(
            () => reply({ type: 'ack', id }),
            (e: Error) => reply({ type: 'nack', id, error: e.message }),
          );
        }
      }
      if (msg.type === 'ar-request' && typeof msg.id === 'string') {
        const id = msg.id;
        makeArPreview().then(
          (ar) => reply({ type: 'ar-ready', id, ...ar }),
          (e: Error) => reply({ type: 'nack', id, error: e.message }),
        );
      }
      if (msg.type === 'tracing' && typeof msg.id === 'string' && Array.isArray(msg.strokes)) {
        const strokes = msg.strokes.filter((s): s is number[] => Array.isArray(s) && s.every((v) => typeof v === 'number' && isFinite(v)));
        const label = VIEWS.includes(msg.label as View) ? (msg.label as View) : 'top';
        const t: Tracing = { id: msg.id, label, strokes, receivedAt: Date.now(), device: msg.device };
        useTablet.setState((s) => ({ inbox: [t, ...s.inbox.filter((x) => x.id !== t.id)].slice(0, 50), lastArrival: Date.now() }));
        ws?.send(JSON.stringify({ type: 'ack', id: msg.id }));
      }
      if (msg.type === 'sketch' && typeof msg.id === 'string' && typeof msg.sketchId === 'string' && /^[a-z0-9]{4,24}$/.test(msg.sketchId) && typeof msg.image === 'string' && msg.image.startsWith('data:image/')) {
        const id = msg.id;
        const strokes = Array.isArray(msg.strokes)
          ? msg.strokes.filter((s): s is number[] => Array.isArray(s) && s.every((v) => typeof v === 'number' && isFinite(v))).slice(0, 5000)
          : undefined;
        const name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : 'Sketch';
        void fetch(msg.image)
          .then((r) => r.blob())
          .then((blob) => addPhoto(blob, { name, source: from, kind: 'sketch', strokes, id: `sketch-${msg.sketchId}` }))
          .then(
            () => reply({ type: 'ack', id }),
            (e: Error) => reply({ type: 'nack', id, error: e.message }),
          );
      }
      if (msg.type === 'photo' && typeof msg.id === 'string' && typeof msg.image === 'string' && msg.image.startsWith('data:image/')) {
        // Decoded and re-encoded locally (prepareImage), so only a valid, downscaled JPEG is kept.
        const id = msg.id;
        const name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : 'Tablet photo';
        void fetch(msg.image)
          .then((r) => r.blob())
          .then((blob) => addPhoto(blob, { name, source: from }))
          .then(
            () => ws?.send(JSON.stringify({ type: 'ack', id })),
            (e: Error) => ws?.send(JSON.stringify({ type: 'nack', id, error: e.message })),
          );
      }
    };
    ws.onclose = () => {
      useTablet.setState({ online: false, pads: 0, devices: [] });
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };
  connect();
}
