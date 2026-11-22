// Browser-side implementations of the tools declared in toolSpecs.ts.
// Both the in-app agent and the Claude Code bridge call `callTool`.

import type { SceneNode, Transform } from '../model/schema';
import { findNode, useStore } from '../model/store';
import { geometry } from '../geometry/client';
import { dropToBed, orientForPrint } from '../model/printActions';
import { viewportApi, type ViewName } from '../ui/viewportApi';
import { isToolName, parseInput, PartialTransform, type ToolInput, type ToolName, type ToolOutput } from './toolSpecs';
import type { z } from 'zod/v4';
import { base64Of, useReferences } from '../model/references';
import { addProposal, attemptByNumber, diaryContext, OUTCOME_LABEL, setOutcome, useDiary, type Attempt } from '../model/diary';
import { getExperience, libraryContext, searchLibrary, useLibrary } from '../model/library';

const r2 = (v: number) => Math.round(v * 100) / 100;

async function worldBox(node: SceneNode) {
  try {
    const b = await geometry.bounds(node);
    return { min: b.min.map(r2), max: b.max.map(r2) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function describe(node: SceneNode, withBox = true): Promise<unknown> {
  const { shape, ...rest } = node;
  const out: Record<string, unknown> = { ...rest };
  if (shape.kind === 'group') {
    out.shape = { kind: 'group', op: shape.op, children: await Promise.all(shape.children.map((c) => describe(c, false))) };
  } else if (shape.kind === 'sketch') {
    out.shape = { ...shape, contours: `<${shape.contours.length} traced outline(s), kept as is>` };
  } else if (shape.kind === 'image') {
    // Don't flood the context with the picture itself.
    out.shape = { ...shape, image: shape.image ? `<grayscale image, kept as is>` : '' };
  } else out.shape = shape;
  if (withBox) out.worldBounds = await worldBox(node);
  return out;
}

/** Reference photos, listed (not shown) in the scene context. */
function referencesContext() {
  const { list, notes } = useReferences.getState();
  if (!list.length && !notes.length) return {};
  const nodes = useStore.getState().allPlates().flatMap((p) => p.nodes);
  const objectOf = (id: string) => (id ? { object: { id, name: findNode(nodes, id)?.name ?? '(deleted)' } } : {});
  const out: Record<string, unknown> = {};
  if (notes.length) {
    out.notes = notes.filter((n) => n.text.trim()).map((n) => ({ text: n.text, ...objectOf(n.objectId) }));
    out.notesNote = 'Notes written by the user (often caliper measurements of the real objects): treat them as reliable.';
  }
  if (!list.length) return out;
  return {
    ...out,
    references: list.map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.kind === 'sketch' ? { kind: 'sketch' } : {}),
      ...(r.caption ? { caption: r.caption } : {}),
      ...(r.objectId ? { object: { id: r.objectId, name: findNode(nodes, r.objectId)?.name ?? '(deleted)' } } : {}),
    })),
    referencesNote:
      'Reference photos of the project (kind "sketch": a hand drawing with written dimensions, made by the user on the tablet): look at them with get_references when they matter for the request.',
  };
}

export async function sceneContext(): Promise<string> {
  const st = useStore.getState();
  const sel = st.selectedId ? findNode(st.nodes, st.selectedId) : null;
  return JSON.stringify({
    selected: sel ? { id: sel.id, name: sel.name } : null,
    plate: {
      current: st.plates.find((p) => p.id === st.activePlate)?.name,
      all: st.plates.map((p) => p.name),
      note: 'The scene below is the current plate only. Object tools act on the current plate; add_plate / switch_plate change it.',
    },
    printer: { bed: st.settings.bed, nozzle: st.settings.nozzle, maxOverhangDeg: st.settings.overhangAngle },
    ...referencesContext(),
    ...diaryContext(),
    ...libraryContext(),
    scene: await Promise.all(st.nodes.map((n) => describe(n))),
  });
}

/** Apply a scene change, verify it still builds, roll back if not. */
async function guarded(id: string | null, change: () => string | void): Promise<string> {
  const before = useStore.getState().nodes;
  const createdId = change() || id;
  if (createdId) {
    const node = findNode(useStore.getState().nodes, createdId);
    if (node) {
      let bounds;
      try {
        bounds = await geometry.bounds(node);
        if (bounds.empty) throw new Error('result is empty (no volume)');
      } catch (e) {
        useStore.setState({ nodes: before });
        throw new Error(`Change rolled back, geometry failed: ${(e as Error).message}`);
      }
      return JSON.stringify({ id: createdId, worldBounds: { min: bounds.min.map(r2), max: bounds.max.map(r2) } });
    }
  }
  return 'ok';
}

function mergeTransform(base: Transform, patch?: z.infer<typeof PartialTransform>): Transform {
  return {
    position: patch?.position ?? base.position,
    rotation: patch?.rotation ?? base.rotation,
    scale: patch?.scale ?? base.scale,
  };
}
const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/**
 * Two animation frames, so React and the renderer catch up. Browsers pause
 * requestAnimationFrame in background tabs (Fabbrico is often behind the terminal),
 * so fall back to a timer instead of waiting forever.
 */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 150);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });

/** Wait until the viewport shows the current scene: React renders, the worker builds, React renders again. */
async function settled() {
  await nextFrame();
  await geometry.idle();
  await nextFrame();
}

const plateName = () => {
  const st = useStore.getState();
  return st.plates.find((p) => p.id === st.activePlate)?.name ?? '';
};

function plateByName(name: string) {
  const plates = useStore.getState().plates;
  const p = plates.find((q) => q.name === name) ?? plates.find((q) => q.name.toLowerCase() === name.trim().toLowerCase());
  if (!p) throw new Error(`No plate named "${name}". Plates: ${plates.map((q) => q.name).join(', ')}`);
  return p;
}

/** The chain of nodes from a root object down to `id`, or null. */
function pathTo(nodes: SceneNode[], id: string): SceneNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    if (n.shape.kind === 'group') {
      const sub = pathTo(n.shape.children, id);
      if (sub) return [n, ...sub];
    }
  }
  return null;
}

type Runners = { [N in ToolName]: (i: ToolInput<N>) => ToolOutput | Promise<ToolOutput> };

const RUNNERS: Runners = {
  get_scene: async () => {
    await settled();
    const shot = viewportApi.capture('current');
    const ctx = await sceneContext();
    return shot ? [ctx, { image: shot }] : ctx;
  },
  add_object: (i) => {
    if (i.shape.kind === 'mesh') throw new Error('Only the user can import meshes (Import… button or drop a file on Fabbrico)');
    if (i.shape.kind === 'image' && !i.shape.image.startsWith('data:image/'))
      throw new Error('Image shapes need a picture: ask the user to add it with the Image button, then edit its parameters');
    return guarded(null, () =>
      useStore.getState().addNode({
        name: i.name,
        shape: i.shape,
        transform: mergeTransform(IDENTITY, i.transform),
        modifiers: i.modifiers ?? [],
        ...(i.color ? { color: i.color } : {}),
        hole: i.hole ?? false,
      }),
    );
  },
  update_object: (i) => {
    const node = findNode(useStore.getState().nodes, i.id);
    if (!node) throw new Error(`No object with id ${i.id}`);
    if (i.shape && node.shape.kind === 'group') throw new Error('Cannot replace the shape of a group');
    const patch: Partial<SceneNode> = {};
    if (i.name !== undefined) patch.name = i.name;
    if (i.color !== undefined) patch.color = i.color;
    if (i.hole !== undefined) patch.hole = i.hole;
    if (i.shape) {
      // Images come from the user: an empty image means "keep the current one".
      if (i.shape.kind === 'sketch' && !i.shape.contours.length) {
        if (node.shape.kind !== 'sketch') throw new Error('Only the user can make tracings (Tablet button in Fabbrico)');
        patch.shape = { ...i.shape, contours: node.shape.contours };
      } else if (i.shape.kind === 'image' && !i.shape.image) {
        if (node.shape.kind !== 'image' || !node.shape.image) throw new Error('Only the user can load an image (Image button in Fabbrico)');
        patch.shape = { ...i.shape, image: node.shape.image };
      } else patch.shape = i.shape;
    }
    if (i.modifiers) patch.modifiers = i.modifiers;
    if (i.transform) patch.transform = mergeTransform(node.transform, i.transform);
    return guarded(i.id, () => useStore.getState().updateNode(i.id, patch));
  },
  delete_objects: (i) => {
    useStore.getState().removeNodes(i.ids);
    return 'ok';
  },
  group_objects: (i) =>
    guarded(null, () => {
      const id = useStore.getState().groupNodes(i.ids, i.op, i.name);
      if (!id) throw new Error('Need at least two existing root-level ids');
      return id;
    }),
  duplicate_objects: async (i) => {
    const st = useStore.getState();
    let plateId: string | undefined;
    if (i.to_plate !== undefined) {
      plateId = plateByName(i.to_plate).id;
    }
    const ids = st.duplicateNodes(i.ids, { offset: i.offset, plateId });
    const all = plateId && plateId !== st.activePlate ? useStore.getState().plates.find((p) => p.id === plateId)!.nodes : useStore.getState().nodes;
    const out = await Promise.all(
      ids.map(async (id) => ({ id, name: findNode(all, id)!.name, worldBounds: await worldBox(findNode(all, id)!) })),
    );
    return JSON.stringify({ plate: i.to_plate ?? plateName(), copies: out });
  },
  add_plate: (i) => {
    if (i.name && useStore.getState().plates.some((p) => p.name === i.name)) throw new Error(`A plate named "${i.name}" already exists`);
    useStore.getState().addPlate(i.name);
    return JSON.stringify({ current: plateName(), all: useStore.getState().plates.map((p) => p.name) });
  },
  switch_plate: (i) => {
    useStore.getState().switchPlate(plateByName(i.name).id);
    return JSON.stringify({ current: plateName(), objects: useStore.getState().nodes.length });
  },
  get_outline: async (i) => {
    const nodes = useStore.getState().nodes;
    const path = pathTo(nodes, i.id);
    if (!path) throw new Error(`No object with id ${i.id} on this plate`);
    const node = path[path.length - 1];
    const ancestors = path.slice(0, -1).reverse().map((n) => n.transform);
    const o = await geometry.outline(node, ancestors, { z: i.z, offset: i.offset, tolerance: i.tolerance });
    const points = o.contours.reduce((a, c) => a + c.length, 0);
    return JSON.stringify({ ...o, points });
  },
  ungroup: (i) => {
    useStore.getState().ungroup(i.id);
    return 'ok';
  },
  place_on_bed: async (i) => {
    for (const id of i.ids) if (useStore.getState().nodes.some((n) => n.id === id)) await dropToBed(id);
    return 'ok';
  },
  orient_for_print: async (i) => {
    const results: Record<string, unknown> = {};
    for (const id of i.ids) results[id] = await orientForPrint(id);
    return JSON.stringify(results);
  },
  render_view: async (i) => {
    const st = useStore.getState();
    const previous = st.overlay;
    if (i.overlay) useStore.setState({ overlay: i.overlay });
    try {
      await settled(); // let the viewport catch up with the latest changes (and compute the overlay)
      const data = viewportApi.capture(i.view as ViewName, i.focus_id);
      if (!data) throw new Error('Viewport not available (is the Fabbrico tab in the background?)');
      return { image: data };
    } finally {
      if (i.overlay) useStore.setState({ overlay: previous });
    }
  },
  get_references: (i) => {
    const list = useReferences.getState().list;
    if (!list.length) throw new Error('The project has no reference photos (the user adds them in the Files tab, by drag and drop or from the tablet)');
    let pick = list;
    if (i.ids?.length) {
      const missing = i.ids.filter((id) => !list.some((r) => r.id === id));
      if (missing.length) throw new Error(`No photo with id ${missing.join(', ')}. Photos: ${list.map((r) => `${r.id} (${r.name})`).join(', ')}`);
      pick = list.filter((r) => i.ids!.includes(r.id));
    } else if (list.length > 6) {
      throw new Error(`There are ${list.length} photos: pass the ids of up to 6. ${list.map((r) => `${r.id} (${r.name}${r.caption ? `: ${r.caption}` : ''})`).join(', ')}`);
    }
    const nodes = useStore.getState().allPlates().flatMap((p) => p.nodes);
    const out: Array<string | { image: string }> = [];
    for (const r of pick) {
      const obj = r.objectId ? findNode(nodes, r.objectId)?.name ?? '(deleted object)' : '';
      out.push(`${r.kind === 'sketch' ? 'Sketch (not to scale; the written numbers are the dimensions, in mm unless a unit is written)' : 'Photo'} ${r.id} "${r.name}"${r.caption ? ` - ${r.caption}` : ''}${obj ? ` (object: ${obj})` : ''}, ${r.width}x${r.height} px:`);
      out.push({ image: base64Of(r) });
    }
    return out;
  },
  check_printability: async () => {
    const st = useStore.getState();
    return JSON.stringify(await geometry.analyze(st.nodes, { bed: st.settings.bed, overhangAngle: st.settings.overhangAngle, nozzle: st.settings.nozzle }));
  },
  get_diary: (i) => {
    const all = useDiary.getState().attempts;
    if (!all.length) return 'The diary is empty: attempts are recorded when the user exports a plate or sends it to the slicer.';
    const describeAttempt = (a: Attempt) => ({
      n: a.n,
      plate: a.plate,
      at: a.at,
      via: a.via,
      context: a.context,
      sizes: a.sizes,
      ...(a.previous ? { comparedWith: a.previous, changes: a.changes } : { first: true }),
      outcome: a.outcome ? { result: a.outcome.result, label: OUTCOME_LABEL[a.outcome.result], note: a.outcome.note, by: a.outcome.source } : 'not reported yet',
      photos: a.photos.length,
      objects: a.objects.map((o) => ({ id: o.id, name: o.name, kind: o.shape.kind })),
    });
    if (!i.attempts?.length) return JSON.stringify(all.map(describeAttempt));
    const out: Array<string | { image: string }> = [];
    for (const n of i.attempts) {
      const a = attemptByNumber(n);
      out.push(JSON.stringify(describeAttempt(a)));
      if (a.render) out.push(`Render of attempt #${a.n}:`, { image: a.render.slice(a.render.indexOf(',') + 1) });
      a.photos.slice(0, 3).forEach((p, k) => out.push(`Photo ${k + 1} of the real print #${a.n}:`, { image: p.slice(p.indexOf(',') + 1) }));
    }
    return out;
  },
  set_attempt_outcome: (i) => {
    const a = attemptByNumber(i.attempt);
    setOutcome(a.id, { result: i.result, note: i.note ?? '', source: 'chat' });
    return `Attempt #${a.n} (${a.plate}): ${OUTCOME_LABEL[i.result]}`;
  },
  propose_experience: (i) => {
    for (const n of i.attempts) attemptByNumber(n);
    const p = addProposal({
      kind: i.kind,
      title: i.title,
      summary: i.summary,
      body: i.body,
      tags: i.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      values: i.values ?? {},
      attempts: i.attempts,
      objectIds: i.object_ids ?? [],
    });
    return `Proposed "${p.title.en}". The user reviews it in the Diary tab (keep / discard).`;
  },
  search_experiences: (i) => {
    if (!useLibrary.getState().available) throw new Error('The experience library needs Fabbrico started from its own server (npm start).');
    const found = searchLibrary(i.query);
    if (!found.length) return i.query ? `No experience matches "${i.query}".` : 'The library is empty.';
    return JSON.stringify(found.slice(0, 20).map(({ thumb: _t, ...e }) => e));
  },
  get_experience: async (i) => {
    const { experience: e, it, en, media } = await getExperience(i.id);
    const out: Array<string | { image: string }> = [
      JSON.stringify({ id: e.id, kind: e.kind, status: e.status, prints: e.prints, context: e.context, values: e.values, tags: e.tags, attempts: e.attempts, source: e.source, hasModel: e.model }),
      `English text:\n${en}`,
      `Italian text:\n${it}`,
    ];
    const pics = [...e.media.filter((m) => m.kind === 'photo'), ...e.media.filter((m) => m.kind === 'render')].slice(0, 4);
    for (const m of pics) if (media[m.file]) out.push(`${m.kind} ${m.file}${m.caption ? `: ${m.caption}` : ''}`, { image: media[m.file].slice(media[m.file].indexOf(',') + 1) });
    return out;
  },
};

/** Validate and run one tool. Throws on invalid input or failure. */
export async function callTool(name: string, input: unknown): Promise<ToolOutput> {
  if (!isToolName(name)) throw new Error(`Unknown tool ${name}`);
  const parsed = parseInput(name, input);
  return (RUNNERS[name] as (i: unknown) => ToolOutput | Promise<ToolOutput>)(parsed);
}

export function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'get_scene':
      return 'read scene';
    case 'add_object':
      return `add ${(i.shape as { kind?: string })?.kind ?? ''} "${i.name}"`;
    case 'update_object':
      return `update ${i.id}: ${Object.keys(i).filter((k) => k !== 'id').join(', ')}`;
    case 'render_view':
      return `look (${i.view})`;
    case 'duplicate_objects':
      return `duplicate ${(i.ids as string[] | undefined)?.length ?? 0} object(s)${i.to_plate ? ` to ${i.to_plate}` : ''}`;
    case 'add_plate':
      return `add plate${i.name ? ` "${i.name}"` : ''}`;
    case 'switch_plate':
      return `switch to ${i.name}`;
    case 'get_outline':
      return `read outline of ${i.id}`;
    case 'check_printability':
      return 'check printability';
    case 'get_references':
      return `look at photos${(i.ids as string[] | undefined)?.length ? ` (${(i.ids as string[]).length})` : ''}`;
    case 'get_diary':
      return 'read diary';
    case 'set_attempt_outcome':
      return `attempt #${i.attempt}: ${i.result}`;
    case 'propose_experience':
      return `propose experience "${(i.title as { en?: string })?.en ?? ''}"`;
    case 'search_experiences':
      return `search experiences${i.query ? ` "${i.query}"` : ''}`;
    case 'get_experience':
      return `read experience ${i.id}`;
    default:
      return `${name} ${JSON.stringify(i).slice(0, 60)}`;
  }
}
