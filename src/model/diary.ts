// Project diary (experimental): every print of a plate is recorded as an
// "attempt" (snapshot, render, sizes, printer context, what changed since the
// previous attempt of that plate), and the maker adds the outcome later (from
// Fabbrico, the phone or the chat). The AI reads the diary to propose experiences
// for the library (experience.ts). Outcomes only come from the maker: the AI
// may record what the user said, never guess one.
//
// Saved in the .fabbrico file and, between sessions, in this browser (IndexedDB).

import { create } from 'zustand';
import { z } from 'zod/v4';
import { legacySource } from '../legacy';
import { idbGet, idbPut } from './assets';
import { SceneNodeSchema, type SceneNode } from './schema';
import { useStore } from './store';
import { printerById } from './printers';
import { geometry } from '../geometry/client';
import { viewportApi } from '../ui/viewportApi';
import { prepareImage } from './references';

export const OUTCOMES = ['ok', 'tight', 'loose', 'broken', 'surface', 'other'] as const;
export type OutcomeResult = (typeof OUTCOMES)[number];
export const OUTCOME_LABEL: Record<OutcomeResult, string> = {
  ok: 'Good',
  tight: 'Too tight',
  loose: 'Too loose',
  broken: 'Failed / broke',
  surface: 'Poor surface',
  other: 'Other',
};
export const OUTCOME_ICON: Record<OutcomeResult, string> = { ok: '✓', tight: '⇥⇤', loose: '⇤⇥', broken: '✗', surface: '≈', other: '…' };

export const OutcomeSchema = z.object({
  result: z.enum(OUTCOMES),
  note: z.string().default(''),
  /** Who recorded it: the maker in Fabbrico, on the phone, or the AI writing down what the maker said in the chat. */
  source: z.preprocess(legacySource, z.enum(['fabbrico', 'phone', 'chat'])).default('fabbrico'),
  at: z.string(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const AttemptSchema = z.object({
  id: z.string(),
  /** 1, 2, 3… within the project. */
  n: z.number().int(),
  plate: z.string(),
  /** How the plate left Fabbrico: "3mf", "stl", "slicer:bambu", "manual". */
  via: z.string(),
  at: z.string(),
  /** Plate objects at that moment (image pictures stripped to keep the file small). */
  objects: z.array(SceneNodeSchema),
  /** Iso render, JPEG data URL. */
  render: z.string().default(''),
  /** World size of each root object (mm). */
  sizes: z.array(z.object({ id: z.string(), name: z.string(), size: z.array(z.number()) })).default([]),
  context: z.object({ printer: z.string(), nozzle: z.number(), material: z.string().default('') }),
  /** What changed since the previous attempt of the same plate, one line each. */
  changes: z.array(z.string()).default([]),
  /** Number of the attempt compared with (0 = first of its plate). */
  previous: z.number().int().default(0),
  outcome: OutcomeSchema.nullable().default(null),
  /** Photos of the real print, JPEG data URLs. */
  photos: z.array(z.string()).default([]),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** An experience the AI proposed from the diary, waiting for the maker to keep or discard it. */
export const ProposalSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(['component', 'technique', 'fit', 'problem']),
  title: z.object({ it: z.string(), en: z.string() }),
  summary: z.object({ it: z.string(), en: z.string() }),
  body: z.object({ it: z.string(), en: z.string() }),
  tags: z.array(z.string()).default([]),
  /** Key values (e.g. clearance_mm: 0.5), language-neutral. */
  values: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Attempts it is based on, by number. */
  attempts: z.array(z.number().int()).default([]),
  /** Objects worth keeping as the model, by id (from the last attempt, or the scene). */
  objectIds: z.array(z.string()).default([]),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const DiarySchema = z.object({
  attempts: z.array(AttemptSchema).default([]),
  proposals: z.array(ProposalSchema).default([]),
});
export type Diary = z.infer<typeof DiarySchema>;

interface DiaryState extends Diary {
  /** Material of the next prints (remembered in this browser). */
  material: string;
}

const MATERIAL_KEY = 'fabbrico.material';
const loadMaterial = () => {
  try {
    return localStorage.getItem(MATERIAL_KEY) ?? 'PLA';
  } catch {
    return 'PLA';
  }
};

export const useDiary = create<DiaryState>(() => ({ attempts: [], proposals: [], material: loadMaterial() }));

useDiary.subscribe((s, prev) => {
  if (s.attempts !== prev.attempts || s.proposals !== prev.proposals)
    void idbPut('diary', { attempts: s.attempts, proposals: s.proposals }).catch(() => {});
  if (s.material !== prev.material) {
    try {
      localStorage.setItem(MATERIAL_KEY, s.material);
    } catch {
      /* ignore */
    }
  }
});

export async function loadDiaryFromBrowser() {
  try {
    const d = DiarySchema.safeParse((await idbGet<unknown>('diary')) ?? {});
    if (d.success) useDiary.setState(d.data);
  } catch {
    /* private mode etc. */
  }
}

/** Replace the diary (opening a project, new project). */
export function setDiary(d: Partial<Diary> = {}) {
  useDiary.setState({ attempts: d.attempts ?? [], proposals: d.proposals ?? [] });
}

export const diaryForFile = (): Diary | undefined => {
  const { attempts, proposals } = useDiary.getState();
  return attempts.length || proposals.length ? { attempts, proposals } : undefined;
};

export const setMaterial = (material: string) => useDiary.setState({ material: material.trim().slice(0, 40) });

function markDirty() {
  const st = useStore.getState();
  if (!st.project.dirty) useStore.setState({ project: { ...st.project, dirty: true } });
}

// ---------------------------------------------------------------- record ----

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Plate objects without heavy data that a diff or a model doesn't need (image pictures). */
function lightCopy(nodes: SceneNode[]): SceneNode[] {
  const strip = (n: SceneNode): SceneNode => {
    if (n.shape.kind === 'group') return { ...n, shape: { ...n.shape, children: n.shape.children.map(strip) } };
    if (n.shape.kind === 'image') return { ...n, shape: { ...n.shape, image: '' } };
    return n;
  };
  return structuredClone(nodes.map(strip));
}

/** Shrink a base64 JPEG (no prefix) to a smaller JPEG data URL. */
async function smallRender(b64: string): Promise<string> {
  const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

const fmt = (v: unknown): string => {
  if (typeof v === 'number') return String(r2(v));
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return `[${v.map((x) => r2(x as number)).join(', ')}]`;
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/** Leaf-level differences of two values, as "path: old → new". Arrays of numbers count as one value. */
function diffValues(a: unknown, b: unknown, path: string, out: string[]) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isNumArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'number');
  if (a && b && typeof a === 'object' && typeof b === 'object' && !isNumArray(a) && !isNumArray(b)) {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
      out.push(`${path}: ${a.length} → ${b.length} items`);
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
    return;
  }
  out.push(`${path}: ${a === undefined ? '—' : fmt(a)} → ${b === undefined ? '—' : fmt(b)}`);
}

/** What changed between two snapshots of a plate, object by object (matched by id). */
export function diffObjects(before: SceneNode[], after: SceneNode[]): string[] {
  const flat = (list: SceneNode[], m = new Map<string, SceneNode>()) => {
    for (const n of list) {
      m.set(n.id, n);
      if (n.shape.kind === 'group') flat(n.shape.children, m);
    }
    return m;
  };
  const A = flat(before), B = flat(after);
  const out: string[] = [];
  // Big data that isn't a parameter: compare by size only.
  const params = (n: SceneNode) => {
    const { shape, id: _id, color: _c, ...rest } = n;
    let s: unknown = shape;
    if (shape.kind === 'group') s = { op: shape.op };
    else if (shape.kind === 'sketch') s = { ...shape, contours: `${shape.contours.length} outlines, ${shape.contours.reduce((t, c) => t + c.length, 0)} values` };
    else if (shape.kind === 'image') s = { ...shape, image: undefined };
    return { ...rest, shape: s };
  };
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) {
      out.push(`added "${b.name}" (${b.shape.kind}${b.hole ? ', hole' : ''})`);
      continue;
    }
    const lines: string[] = [];
    diffValues(params(a), params(b), '', lines);
    for (const l of lines) out.push(`"${b.name}"${l.startsWith('.') ? ' ' + l.slice(1) : l}`);
  }
  for (const [id, a] of A) if (!B.has(id)) out.push(`removed "${a.name}"`);
  return out.slice(0, 40);
}

/**
 * Record the active plate as an attempt (called when it is exported or sent to
 * a slicer). Re-exporting an unchanged plate does not add a new attempt.
 */
export async function recordAttempt(via: string): Promise<Attempt | null> {
  const st = useStore.getState();
  const plate = st.plates.find((p) => p.id === st.activePlate)?.name ?? 'Plate';
  if (!st.nodes.length) return null;
  const objects = lightCopy(st.nodes);
  const { attempts, material } = useDiary.getState();
  const prev = [...attempts].reverse().find((a) => a.plate === plate);
  const printer = printerById(st.settings.printer)?.name ?? `custom ${st.settings.bed.join('×')}`;
  if (prev && JSON.stringify(prev.objects) === JSON.stringify(objects) && prev.context.material === material && prev.context.printer === printer) return prev;

  const sizes = await Promise.all(
    st.nodes.map(async (n) => {
      try {
        const b = await geometry.bounds(n);
        return { id: n.id, name: n.name, size: [0, 1, 2].map((k) => r2(b.max[k] - b.min[k])) };
      } catch {
        return { id: n.id, name: n.name, size: [] };
      }
    }),
  );
  let render = '';
  try {
    const shot = viewportApi.capture('iso');
    if (shot) render = await smallRender(shot);
  } catch {
    /* no render: not essential */
  }
  const attempt: Attempt = {
    id: `att${Date.now().toString(36)}`,
    n: (attempts[attempts.length - 1]?.n ?? 0) + 1,
    plate,
    via,
    at: new Date().toISOString(),
    objects,
    render,
    sizes,
    context: { printer, nozzle: st.settings.nozzle, material },
    changes: prev ? diffObjects(prev.objects, objects) : [],
    previous: prev?.n ?? 0,
    outcome: null,
    photos: [],
  };
  useDiary.setState((s) => ({ attempts: [...s.attempts, attempt] }));
  markDirty();
  return attempt;
}

export function attemptByNumber(n: number): Attempt {
  const a = useDiary.getState().attempts.find((x) => x.n === n);
  if (!a) throw new Error(`No attempt #${n}. Attempts: ${useDiary.getState().attempts.map((x) => `#${x.n}`).join(', ') || 'none yet'}`);
  return a;
}

function editAttempt(id: string, fn: (a: Attempt) => Attempt) {
  useDiary.setState((s) => ({ attempts: s.attempts.map((a) => (a.id === id ? fn(a) : a)) }));
  markDirty();
}

export function setOutcome(id: string, outcome: Omit<Outcome, 'at'> | null) {
  editAttempt(id, (a) => ({ ...a, outcome: outcome ? { ...outcome, note: outcome.note.trim().slice(0, 2000), at: new Date().toISOString() } : null }));
}

export async function addAttemptPhoto(id: string, blob: Blob) {
  const { image } = await prepareImage(blob);
  editAttempt(id, (a) => ({ ...a, photos: [...a.photos, image].slice(-8) }));
}

export function removeAttemptPhoto(id: string, index: number) {
  editAttempt(id, (a) => ({ ...a, photos: a.photos.filter((_, i) => i !== index) }));
}

export function removeAttempt(id: string) {
  useDiary.setState((s) => ({ attempts: s.attempts.filter((a) => a.id !== id) }));
  markDirty();
}

// ------------------------------------------------------------- proposals ----

export function addProposal(p: Omit<Proposal, 'id' | 'at'>): Proposal {
  const proposal: Proposal = { ...p, id: `prop${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, at: new Date().toISOString() };
  useDiary.setState((s) => ({ proposals: [...s.proposals, proposal] }));
  markDirty();
  return proposal;
}

export function updateProposal(id: string, patch: Partial<Proposal>) {
  useDiary.setState((s) => ({ proposals: s.proposals.map((p) => (p.id === id ? { ...p, ...patch, id } : p)) }));
  markDirty();
}

export function removeProposal(id: string) {
  useDiary.setState((s) => ({ proposals: s.proposals.filter((p) => p.id !== id) }));
  markDirty();
}

/** Compact view of the diary for the AI (no images, no snapshots). */
export function diaryContext() {
  const { attempts, proposals } = useDiary.getState();
  if (!attempts.length && !proposals.length) return {};
  return {
    diary: {
      attempts: attempts.slice(-20).map((a) => ({
        n: a.n,
        plate: a.plate,
        at: a.at.slice(0, 16).replace('T', ' '),
        context: a.context,
        ...(a.previous ? { comparedWith: a.previous, changes: a.changes.slice(0, 8), ...(a.changes.length > 8 ? { moreChanges: a.changes.length - 8 } : {}) } : {}),
        outcome: a.outcome ? { result: a.outcome.result, note: a.outcome.note || undefined, by: a.outcome.source } : 'not reported yet',
        ...(a.photos.length ? { photos: a.photos.length } : {}),
      })),
      ...(proposals.length ? { pendingProposals: proposals.map((p) => p.title.en) } : {}),
      note: 'Project diary: each attempt is a print of a plate. Read details with get_diary.',
    },
  };
}
