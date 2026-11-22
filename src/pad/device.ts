// What the tablet page and the phone page share: which kind of device this is,
// and the features both have (photos, notes, AR preview). Tracing is only on
// the tablet page (main.ts): a phone screen is too small to trace objects on.

export type DeviceKind = 'tablet' | 'phone';

const MODE_KEY = 'fabbrico.pad.mode';

/** A phone if the screen's short side is under 600 points, unless the user chose otherwise. */
export function deviceKind(): DeviceKind {
  const forced = new URLSearchParams(location.search).get('mode');
  if (forced === 'phone' || forced === 'tablet') return forced;
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'phone' || saved === 'tablet') return saved;
  } catch {
    /* ignore */
  }
  return Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet';
}

/** Switch this device to the other page (remembered) and reload. */
export function switchKind(to: DeviceKind) {
  try {
    localStorage.setItem(MODE_KEY, to);
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  url.searchParams.delete('mode');
  location.replace(url.toString());
}

export const FEATURES: Record<DeviceKind, string[]> = {
  tablet: ['Trace objects with the pencil', 'Sketch parts with dimensions', 'Photos for the project', 'Measurement notes', 'AR preview of the plate'],
  phone: ['Photos for the project', 'Measurement notes', 'Print outcomes with photos', 'AR preview of the plate'],
};

// ------------------------------------------------------------- features ----

export interface Link {
  /** Sends a message to Fabbrico; false if Fabbrico is not connected. */
  send: (msg: object) => boolean;
  toast: (text: string, ms?: number) => void;
}

const PHOTO_MAX_PX = 1600;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** Requests waiting for Fabbrico's answer: what to say when it comes. */
const waiting = new Map<string, { ok: string; timer: number }>();

function expect(id: string, ok: string, link: Link, timeoutMs: number, lost: string) {
  const timer = window.setTimeout(() => {
    if (waiting.delete(id)) link.toast(lost, 5000);
  }, timeoutMs);
  waiting.set(id, { ok, timer });
}

/** Answers to "which attempts are there?", by request id. */
const attemptLists = new Map<string, (list: AttemptInfo[]) => void>();

/** Handles Fabbrico's answers to photos, notes and AR requests. Returns true if the message was one of them. */
export function handleReply(msg: { type: string; id?: string; error?: string; path?: string; plate?: string; objects?: number; list?: AttemptInfo[] }, link: Link): boolean {
  if (msg.type === 'attempts' && msg.id && attemptLists.has(msg.id)) {
    attemptLists.get(msg.id)!(Array.isArray(msg.list) ? msg.list : []);
    attemptLists.delete(msg.id);
    return true;
  }
  if (!msg.id || !waiting.has(msg.id)) return false;
  const w = waiting.get(msg.id)!;
  waiting.delete(msg.id);
  clearTimeout(w.timer);
  if (msg.type === 'ack') link.toast(w.ok);
  else if (msg.type === 'nack') link.toast(`Fabbrico: ${msg.error ?? 'something went wrong'}`, 6000);
  else if (msg.type === 'ar-ready' && msg.path) showAr(msg.path, msg.plate ?? '', msg.objects ?? 0);
  return true;
}

/** Decode with an <img> (the most compatible way on iOS Safari; it applies the EXIF rotation), shrink, re-encode. */
async function shrinkPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('empty image');
    const k = Math.min(1, PHOTO_MAX_PX / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Opens the camera / photo library and sends the chosen photos. */
export function pickAndSendPhotos(link: Link, kind: DeviceKind) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...(input.files ?? [])];
    for (const [k, f] of files.entries()) {
      try {
        link.toast(files.length > 1 ? `Sending photo ${k + 1} of ${files.length}…` : 'Sending photo…', 10000);
        const image = await shrinkPhoto(f);
        const id = newId();
        const stamp = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        const name = `${kind === 'phone' ? 'Phone' : 'Tablet'} photo ${stamp}${files.length > 1 ? ` (${k + 1})` : ''}`;
        if (!link.send({ type: 'photo', id, name, image, from: kind })) return;
        expect(id, 'Photo added to the project ✓', link, 15000, 'Fabbrico did not confirm the photo: try again');
      } catch (err) {
        link.toast(`Could not read ${f.name}: ${(err as Error).message}`, 6000);
      }
    }
  };
  input.click();
}

/** Asks for a note (e.g. measurements) and sends it. */
export function writeAndSendNote(link: Link, kind: DeviceKind) {
  const dlg = document.createElement('div');
  dlg.className = 'sheet-backdrop';
  dlg.innerHTML = `
    <div class="sheet">
      <h3>Note for the project</h3>
      <p class="muted">Measurements or facts about the real object. The AI takes them as reliable.</p>
      <textarea rows="5" placeholder="e.g. geode base 58 × 74 mm, height 85 mm"></textarea>
      <div class="sheet-actions">
        <button data-act="cancel">Cancel</button>
        <button data-act="send" class="primary">Send to Fabbrico</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const ta = dlg.querySelector('textarea')!;
  ta.focus();
  dlg.onclick = (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    if (e.target === dlg || act === 'cancel') dlg.remove();
    if (act === 'send') {
      const text = ta.value.trim();
      if (!text) return;
      const id = newId();
      if (!link.send({ type: 'note', id, text, from: kind })) return;
      expect(id, 'Note added to the project ✓', link, 8000, 'Fabbrico did not confirm the note: try again');
      dlg.remove();
    }
  };
}

/** Asks Fabbrico for an AR model of the plate it is showing. */
export function requestAr(link: Link, kind: DeviceKind) {
  const id = newId();
  if (!link.send({ type: 'ar-request', id, from: kind })) return;
  link.toast('Preparing the 3D model…', 30000);
  expect(id, '', link, 60000, 'Fabbrico did not answer: try again');
}

/** AR Quick Look opens only from a tap on an <a rel="ar"> that contains an image. */
function showAr(path: string, plate: string, objects: number) {
  document.getElementById('toast')?.classList.remove('show');
  const dlg = document.createElement('div');
  dlg.className = 'sheet-backdrop';
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  dlg.innerHTML = `
    <div class="sheet">
      <h3>AR preview ready</h3>
      <p class="muted">Plate “${plate.replace(/[<>&"]/g, '')}”, ${objects} object${objects === 1 ? '' : 's'}, at real size. Point the camera at a table.</p>
      <a rel="ar" class="ar-link" href="${path}"><img src="/pad-icon.png" alt="" /><span>Open in AR</span></a>
      ${ios ? '' : '<p class="muted small">AR Quick Look needs an iPhone or iPad (Safari). Here the file is just downloaded.</p>'}
      <div class="sheet-actions"><button data-act="close">Close</button></div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.onclick = (e) => {
    if (e.target === dlg || (e.target as HTMLElement).dataset.act === 'close') dlg.remove();
  };
}

// ------------------------------------------------------- print outcomes ----

/** A print attempt as Fabbrico sends it to the phone (see diary.ts). */
export interface AttemptInfo {
  id: string;
  n: number;
  plate: string;
  at: string;
  render: string;
  outcome: string | null;
  note: string;
}

const OUTCOMES: [string, string][] = [
  ['ok', '✓ Good'],
  ['tight', 'Too tight'],
  ['loose', 'Too loose'],
  ['broken', '✗ Failed'],
  ['surface', 'Poor surface'],
  ['other', 'Other'],
];

const esc = (t: string) => t.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Asks Fabbrico for the recent print attempts, then lets the user report how one went, with photos. */
export function reportOutcome(link: Link, kind: DeviceKind) {
  const id = newId();
  if (!link.send({ type: 'attempts-request', id, from: kind })) return;
  link.toast('Asking Fabbrico for the prints…', 8000);
  const timer = window.setTimeout(() => attemptLists.delete(id) && link.toast('Fabbrico did not answer: try again', 5000), 10000);
  attemptLists.set(id, (list) => {
    clearTimeout(timer);
    document.getElementById('toast')?.classList.remove('show');
    if (!list.length) {
      link.toast('No prints recorded yet: export the plate or send it to the slicer in Fabbrico first.', 6000);
      return;
    }
    chooseAttempt(list, link, kind);
  });
}

function chooseAttempt(list: AttemptInfo[], link: Link, kind: DeviceKind) {
  const dlg = document.createElement('div');
  dlg.className = 'sheet-backdrop';
  dlg.innerHTML = `
    <div class="sheet">
      <h3>Which print?</h3>
      <div class="attempt-list">
        ${list
          .map(
            (a, k) => `<button class="attempt-pick" data-k="${k}">
              ${a.render ? `<img src="${a.render}" alt="" />` : '<span class="ph"></span>'}
              <span><b>#${a.n} · ${esc(a.plate)}</b><small>${new Date(a.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${a.outcome ? ` · ${esc(OUTCOMES.find((o) => o[0] === a.outcome)?.[1] ?? a.outcome)}` : ' · not reported'}</small></span>
            </button>`,
          )
          .join('')}
      </div>
      <div class="sheet-actions"><button data-act="cancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (e.target === dlg || t.dataset.act === 'cancel') return dlg.remove();
    const pick = t.closest<HTMLElement>('.attempt-pick');
    if (pick) {
      dlg.remove();
      outcomeSheet(list[Number(pick.dataset.k)], link, kind);
    }
  };
}

function outcomeSheet(a: AttemptInfo, link: Link, kind: DeviceKind) {
  let result = a.outcome ?? '';
  const photos: string[] = [];
  const dlg = document.createElement('div');
  dlg.className = 'sheet-backdrop';
  dlg.innerHTML = `
    <div class="sheet">
      <h3>#${a.n} · ${esc(a.plate)}: how did it go?</h3>
      <div class="outcome-chips">${OUTCOMES.map(([v, l]) => `<button data-r="${v}" class="${v === result ? 'on' : ''}">${l}</button>`).join('')}</div>
      <textarea rows="3" placeholder="Details, e.g. enters with a bit of force, retainer clicks in">${esc(a.note)}</textarea>
      <div class="outcome-photos"><button data-act="photo">📷 Add photo</button><span class="muted small" data-photos></span></div>
      <div class="sheet-actions">
        <button data-act="cancel">Cancel</button>
        <button data-act="send" class="primary">Send to Fabbrico</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const count = dlg.querySelector<HTMLElement>('[data-photos]')!;
  dlg.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (e.target === dlg || t.dataset.act === 'cancel') return dlg.remove();
    if (t.dataset.r) {
      result = t.dataset.r;
      dlg.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.r === result));
    }
    if (t.dataset.act === 'photo') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async () => {
        for (const f of input.files ?? []) {
          try {
            photos.push(await shrinkPhoto(f));
          } catch (err) {
            link.toast(`Could not read ${f.name}: ${(err as Error).message}`, 5000);
          }
        }
        count.textContent = photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''}` : '';
      };
      input.click();
    }
    if (t.dataset.act === 'send') {
      if (!result) return link.toast('Choose how it went');
      const id = newId();
      const note = dlg.querySelector('textarea')!.value.trim();
      if (!link.send({ type: 'outcome', id, attemptId: a.id, result, note, photos, from: kind })) return;
      expect(id, 'Outcome saved in the diary ✓', link, 20000, 'Fabbrico did not confirm: try again');
      dlg.remove();
    }
  };
}
