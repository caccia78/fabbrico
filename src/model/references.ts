// Reference photos: pictures of the real objects a design has to fit or hold
// (e.g. the geode of a lamp). They belong to the project, not to a plate; the
// AI can look at them (get_references). Stored downscaled as JPEG data URLs:
// in IndexedDB between sessions and inside .fabbrico files when saving.

import { create } from 'zustand';
import { z } from 'zod/v4';
import { legacySource } from '../legacy';
import { idbGet, idbPut } from './assets';
import { useStore } from './store';

/** Longest side of a stored photo, in pixels. Plenty for the AI, small in the project file. */
export const PHOTO_MAX_PX = 1600;
const JPEG_QUALITY = 0.85;
const IDB_KEY = 'references';

export const ReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  caption: z.string().default(''),
  /** JPEG data URL. */
  image: z.string().startsWith('data:image/jpeg;base64,'),
  width: z.number(),
  height: z.number(),
  /** Object the photo shows or is for (id, as on its plate); empty = whole project. */
  objectId: z.string().default(''),
  source: z.enum(['file', 'tablet', 'phone']).default('file'),
  addedAt: z.string(),
  /** "sketch": a hand drawing with written dimensions, made on the tablet (not to scale, but its numbers are). */
  kind: z.enum(['photo', 'sketch']).default('photo'),
  /** Sketches only: the pencil strokes (mm, x0 y0 x1 y1…), to open them again on the tablet later. */
  strokes: z.array(z.array(z.number())).optional(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

/** A written note: typically measurements taken with a caliper. The AI treats them as reliable. */
export const NoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  objectId: z.string().default(''),
  source: z.preprocess(legacySource, z.enum(['fabbrico', 'tablet', 'phone'])).default('fabbrico'),
  addedAt: z.string(),
});
export type Note = z.infer<typeof NoteSchema>;

interface ReferencesState {
  list: Reference[];
  notes: Note[];
  /** Photos and notes that arrived from a device and were not looked at yet. */
  unseen: number;
}

export const useReferences = create<ReferencesState>(() => ({ list: [], notes: [], unseen: 0 }));

/** Persist in this browser so a refresh keeps them (like the plates). */
useReferences.subscribe((s, prev) => {
  if (s.list !== prev.list) void idbPut(IDB_KEY, s.list).catch(() => {});
  if (s.notes !== prev.notes) void idbPut('notes', s.notes).catch(() => {});
});

export async function loadReferencesFromBrowser() {
  try {
    const photos = z.array(ReferenceSchema).safeParse((await idbGet<unknown>(IDB_KEY)) ?? []);
    const notes = z.array(NoteSchema).safeParse((await idbGet<unknown>('notes')) ?? []);
    useReferences.setState({ list: photos.success ? photos.data : [], notes: notes.success ? notes.data : [] });
  } catch {
    /* private mode etc. */
  }
}

/** Replace all photos and notes (opening a project, new project). Not an edit: the project stays clean. */
export function setReferences(list: Reference[], notes: Note[] = []) {
  useReferences.setState({ list, notes, unseen: 0 });
}

// ------------------------------------------------------------------ notes ----

const newNoteId = () => `note${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function addNote(text: string, opts: { source?: Note['source']; objectId?: string } = {}): string {
  const note: Note = {
    id: newNoteId(),
    text: text.trim().slice(0, 4000),
    objectId: opts.objectId ?? '',
    source: opts.source ?? 'fabbrico',
    addedAt: new Date().toISOString(),
  };
  useReferences.setState((s) => ({ notes: [...s.notes, note], unseen: s.unseen + (note.source === 'fabbrico' ? 0 : 1) }));
  markDirty();
  return note.id;
}

export function updateNote(id: string, patch: Partial<Pick<Note, 'text' | 'objectId'>>) {
  useReferences.setState((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  markDirty();
}

export function removeNote(id: string) {
  useReferences.setState((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
  markDirty();
}

function markDirty() {
  const st = useStore.getState();
  if (!st.project.dirty) useStore.setState({ project: { ...st.project, dirty: true } });
}

function edit(fn: (list: Reference[]) => Reference[]) {
  useReferences.setState((s) => ({ list: fn(s.list) }));
  markDirty();
}

export function updateReference(id: string, patch: Partial<Pick<Reference, 'name' | 'caption' | 'objectId'>>) {
  edit((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export function removeReference(id: string) {
  edit((list) => list.filter((r) => r.id !== id));
}

export const markReferencesSeen = () => useReferences.setState({ unseen: 0 });

const newRefId = () => `photo${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * Decode any image the browser can read, apply its EXIF rotation, downscale it to
 * PHOTO_MAX_PX and re-encode it as JPEG. Re-encoding also guarantees that what
 * we store (and send to the AI) is a plain, valid image.
 */
export async function prepareImage(blob: Blob): Promise<{ image: string; width: number; height: number }> {
  // An <img> decodes everything the browser can show and applies the EXIF rotation.
  const url = URL.createObjectURL(blob);
  const bmp = new Image();
  try {
    bmp.src = url;
    await bmp.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('This browser cannot read that picture (HEIC photos: export them as JPEG first).');
  }
  URL.revokeObjectURL(url);
  const k = Math.min(1, PHOTO_MAX_PX / Math.max(bmp.naturalWidth, bmp.naturalHeight));
  const width = Math.max(1, Math.round(bmp.naturalWidth * k));
  const height = Math.max(1, Math.round(bmp.naturalHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs: white, not black, behind
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  return { image: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width, height };
}

const baseName = (file: string) => file.replace(/\.[^.]+$/, '') || 'photo';

export async function addPhoto(
  blob: Blob,
  opts: { name: string; source?: Reference['source']; objectId?: string; kind?: Reference['kind']; strokes?: number[][]; id?: string },
): Promise<string> {
  const img = await prepareImage(blob);
  // A sketch sent again from the tablet replaces its previous version (same id), keeping name, caption and link.
  const old = opts.id ? useReferences.getState().list.find((r) => r.id === opts.id) : undefined;
  if (old) {
    edit((list) => list.map((r) => (r.id === old.id ? { ...r, ...img, strokes: opts.strokes, addedAt: new Date().toISOString() } : r)));
    useReferences.setState((s) => ({ unseen: s.unseen + 1 }));
    return old.id;
  }
  const ref: Reference = {
    id: opts.id ?? newRefId(),
    name: opts.name.trim() || 'photo',
    caption: '',
    objectId: opts.objectId ?? '',
    source: opts.source ?? 'file',
    addedAt: new Date().toISOString(),
    kind: opts.kind ?? 'photo',
    ...(opts.strokes ? { strokes: opts.strokes } : {}),
    ...img,
  };
  edit((list) => [...list, ref]);
  if (ref.source !== 'file') useReferences.setState((s) => ({ unseen: s.unseen + 1 }));
  return ref.id;
}

/** Add picture files (file picker or drag and drop), linked to the selected object if any. Returns errors, if any. */
export async function addPhotoFiles(files: Iterable<File>): Promise<string[]> {
  const errors: string[] = [];
  const objectId = useStore.getState().selectedId ?? '';
  for (const f of files) {
    try {
      await addPhoto(f, { name: baseName(f.name), objectId });
    } catch (e) {
      errors.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  return errors;
}

export const isImageFile = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name);

/** Show a file picker for photos. */
export function pickPhotoFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/** Base64 JPEG (without the data: prefix), as the AI tools return images. */
export const base64Of = (r: Reference) => r.image.slice(r.image.indexOf(',') + 1);
