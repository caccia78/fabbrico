// Experience library client (experimental): talks to the local server
// (server/library.ts) and turns a proposal from the diary into an experience
// folder on disk. Only works when Fabbrico runs from its own dev server.

import { create } from 'zustand';
import { z } from 'zod/v4';
import { attemptByNumber, removeProposal, useDiary, OUTCOME_LABEL, type Attempt, type Proposal } from './diary';
import { ExperienceSchema, slugify, type Experience, type ExperienceSummary, type SavePayload } from './experienceSchema';
import { SceneNodeSchema, type SceneNode } from './schema';
import { findNode, useStore } from './store';
import { printerById } from './printers';

const HEADERS = { 'X-Fabbrico': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/local-api/library${path}`, { ...init, headers: { ...HEADERS, ...init.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

interface LibraryState {
  /** False when the local server isn't there (Fabbrico not started with npm start). */
  available: boolean;
  dir: string;
  items: ExperienceSummary[];
}

export const useLibrary = create<LibraryState>(() => ({ available: false, dir: '', items: [] }));

export async function loadLibrary() {
  try {
    const r = await call<{ dir: string; items: ExperienceSummary[] }>('');
    useLibrary.setState({ available: true, dir: r.dir, items: r.items });
  } catch {
    useLibrary.setState({ available: false, items: [] });
  }
}

export interface FullExperience {
  experience: Experience;
  it: string;
  en: string;
  media: Record<string, string>;
  model?: unknown[];
  dir: string;
}

export async function getExperience(id: string): Promise<FullExperience> {
  const r = await call<FullExperience>(`/item?id=${encodeURIComponent(id)}`);
  return { ...r, experience: ExperienceSchema.parse(r.experience) };
}

export const openLibraryFolder = (id?: string) => call('/open' + (id ? `?id=${encodeURIComponent(id)}` : ''), { method: 'POST' });

/** Add the experience's model objects to the current plate. */
export async function insertExperienceModel(id: string): Promise<string[]> {
  const { model } = await getExperience(id);
  if (!model?.length) throw new Error('This experience has no model');
  const nodes = z.array(SceneNodeSchema).parse(model);
  const st = useStore.getState();
  st.checkpoint();
  return st.pasteNodes(nodes);
}

/** Search the index by words in titles, summaries and tags (both languages). */
export function searchLibrary(query = ''): ExperienceSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = useLibrary.getState().items;
  if (!words.length) return items;
  const score = (e: ExperienceSummary) => {
    const hay = [e.title.it, e.title.en, e.summary.it, e.summary.en, e.kind, ...e.tags].join(' ').toLowerCase();
    return words.filter((w) => hay.includes(w)).length;
  };
  return items
    .map((e) => [e, score(e)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e);
}

/** Compact index for the AI's context. */
export function libraryContext() {
  const { available, items } = useLibrary.getState();
  if (!available || !items.length) return {};
  return {
    experiences: items.slice(0, 40).map((e) => ({ id: e.id, kind: e.kind, title: e.title.en, tags: e.tags, status: e.status, context: `${e.context.printer}, ${e.context.material}` })),
    experiencesNote: 'The maker\'s experience library (real prints): read the relevant ones with get_experience before designing similar parts.',
  };
}

// ------------------------------------------------------------------ save ----

function findIn(nodes: SceneNode[], id: string): SceneNode | null {
  return findNode(nodes, id);
}

const outcomeText = (a: Attempt) => (a.outcome ? OUTCOME_LABEL[a.outcome.result].toLowerCase() : 'no outcome');
const OUTCOME_IT: Record<string, string> = { ok: 'buono', tight: 'troppo stretto', loose: 'troppo largo', broken: 'fallito / rotto', surface: 'superficie scadente', other: 'altro' };

function attemptsMarkdown(attempts: Attempt[], lang: 'it' | 'en'): string {
  if (!attempts.length) return '';
  const head = lang === 'it' ? '## Prove\n\n| # | Piatto | Cosa è cambiato | Esito |\n|---|---|---|---|' : '## Attempts\n\n| # | Plate | What changed | Outcome |\n|---|---|---|---|';
  const rows = attempts.map((a) => {
    const changes = a.previous ? a.changes.slice(0, 4).join('; ') + (a.changes.length > 4 ? ' …' : '') : lang === 'it' ? 'prima prova' : 'first attempt';
    const res = a.outcome ? (lang === 'it' ? OUTCOME_IT[a.outcome.result] : outcomeText(a)) + (a.outcome.note ? `: ${a.outcome.note}` : '') : lang === 'it' ? 'nessun esito' : 'no outcome';
    return `| ${a.n} | ${a.plate} | ${changes.replace(/\|/g, '/')} | ${res.replace(/\|/g, '/')} |`;
  });
  return `${head}\n${rows.join('\n')}`;
}

function markdown(p: Proposal, attempts: Attempt[], exp: Experience, lang: 'it' | 'en'): string {
  const ctx = `${exp.context.printer}, ${lang === 'it' ? 'ugello' : 'nozzle'} ${exp.context.nozzle} mm, ${exp.context.material}`;
  const values = Object.entries(p.values).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n');
  return [
    `# ${p.title[lang]}`,
    `_${p.summary[lang]}_`,
    `${lang === 'it' ? 'Stato' : 'Status'}: **${exp.status}** · ${lang === 'it' ? 'Contesto' : 'Context'}: ${ctx}`,
    p.body[lang].trim(),
    values ? `## ${lang === 'it' ? 'Valori' : 'Values'}\n\n${values}` : '',
    attemptsMarkdown(attempts, lang),
  ]
    .filter(Boolean)
    .join('\n\n') + '\n';
}

/** Save a proposal as an experience folder. Status and prints come from the outcomes the maker reported. */
export async function saveProposal(p: Proposal): Promise<string> {
  const attempts = p.attempts.map((n) => attemptByNumber(n)).sort((a, b) => a.n - b.n);
  const reported = attempts.filter((a) => a.outcome);
  const last = attempts[attempts.length - 1];
  const status: Experience['status'] = !reported.length ? 'hypothesis' : last?.outcome?.result === 'ok' ? 'confirmed' : 'tested';
  const st = useStore.getState();
  const context = last?.context ?? {
    printer: printerById(st.settings.printer)?.name ?? 'custom',
    nozzle: st.settings.nozzle,
    material: useDiary.getState().material,
  };

  // Media: each attempt's render and photos.
  const media: SavePayload['media'] = {};
  const mediaList: Experience['media'] = [];
  const expAttempts: Experience['attempts'] = [];
  for (const a of attempts) {
    const entry: Experience['attempts'][number] = {
      n: a.n,
      plate: a.plate,
      at: a.at,
      changes: a.changes,
      outcome: a.outcome?.result ?? 'none',
      note: a.outcome?.note ?? '',
      photos: [],
    };
    if (a.render.startsWith('data:image/jpeg')) {
      const file = `attempt-${a.n}.jpg`;
      media[file] = a.render;
      mediaList.push({ file, kind: 'render', caption: `#${a.n} ${a.plate} (${outcomeText(a)})` });
      entry.render = file;
    }
    a.photos.forEach((ph, k) => {
      const file = `attempt-${a.n}-photo-${k + 1}.jpg`;
      media[file] = ph;
      mediaList.push({ file, kind: 'photo', caption: `#${a.n} ${a.plate}: print photo ${k + 1}` });
      entry.photos.push(file);
    });
    expAttempts.push(entry);
  }

  // Model: the chosen objects as they were in the last attempt (or as they are now).
  const current = st.allPlates().flatMap((pl) => pl.nodes);
  const model = p.objectIds
    .map((id) => (last ? findIn(last.objects, id) : null) ?? findIn(current, id))
    .filter((n): n is SceneNode => !!n);

  const taken = new Set(useLibrary.getState().items.map((e) => e.id));
  const base = slugify(p.title.en);
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
  const now = new Date().toISOString();
  const experience: Experience = {
    format: 'fabbrico-experience',
    version: 1,
    id,
    kind: p.kind,
    title: p.title,
    summary: p.summary,
    tags: p.tags,
    status,
    prints: reported.length,
    context,
    values: p.values,
    attempts: expAttempts,
    source: { project: st.project.name },
    media: mediaList,
    model: model.length > 0,
    createdAt: now,
    updatedAt: now,
  };
  const payload: SavePayload = {
    experience,
    it: markdown(p, attempts, experience, 'it'),
    en: markdown(p, attempts, experience, 'en'),
    media,
    ...(model.length ? { model } : {}),
  };
  await call('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  removeProposal(p.id);
  await loadLibrary();
  return id;
}
