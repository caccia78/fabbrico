import { create } from 'zustand';
import { CUSTOM, DEFAULT_PRINTER } from './printers';
import {
  PALETTE,
  defaultShape,
  identity,
  type LeafShape,
  type SceneNode,
  type ShapeKind,
} from './schema';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
/** Analysis colouring shown in the viewport. */
export type Overlay = 'none' | 'overhangs' | 'thickness';

interface Settings {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Printer preset id (printers.ts) or 'custom' when the sizes were typed in. */
  printer: string;
  bed: [number, number, number];
  nozzle: number;
  overhangAngle: number;
  theme: Theme;
}

export type Theme = 'dark' | 'light' | 'system';

export interface ProjectInfo {
  name: string;
  /** Changed since the last save / open / new. */
  dirty: boolean;
}

/** A build plate. The active plate's live data is in State.nodes/past/future. */
export interface Plate {
  id: string;
  name: string;
  nodes: SceneNode[];
  past: SceneNode[][];
  future: SceneNode[][];
}

interface State {
  /** Objects on the active plate. */
  nodes: SceneNode[];
  plates: Plate[];
  activePlate: string;
  project: ProjectInfo;
  selectedId: string | null;
  gizmo: GizmoMode;
  overlay: Overlay;
  /** Waiting for a click on the viewport to pick a face for a modifier. */
  picking: { nodeId: string; modIndex: number } | null;
  past: SceneNode[][];
  future: SceneNode[][];
  settings: Settings;

  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  setGizmo: (m: GizmoMode) => void;
  toggleOverlay: (o: Exclude<Overlay, 'none'>) => void;
  setPicking: (p: State['picking']) => void;
  setSettings: (s: Partial<Settings>) => void;

  // Mutations. They do NOT push history themselves: callers decide the
  // granularity (one checkpoint per UI gesture, one per AI turn).
  addNode: (partial: Partial<SceneNode> & { shape: SceneNode['shape'] }) => string;
  updateNode: (id: string, patch: Partial<SceneNode>) => void;
  removeNodes: (ids: string[]) => void;
  groupNodes: (ids: string[], op: 'union' | 'intersection', name?: string) => string | null;
  ungroup: (id: string) => void;
  /**
   * Copy objects (root or nested; a nested object is copied as a root object with
   * its transform relative to its old parent) with fresh ids, moved by `offset`,
   * onto the active plate or onto `plateId`. Returns the new ids.
   */
  duplicateNodes: (ids: string[], opts?: { offset?: [number, number, number]; plateId?: string }) => string[];
  /** Add copies (fresh ids) of the given nodes to the active plate and select the last one. */
  pasteNodes: (nodes: SceneNode[]) => string[];
  replaceScene: (nodes: SceneNode[]) => void;

  // Plates. Each keeps its own objects and undo history.
  /** Add an empty plate and make it active. Returns its id. */
  addPlate: (name?: string) => string;
  switchPlate: (id: string) => void;
  renamePlate: (id: string, name: string) => void;
  removePlate: (id: string) => void;
  /** All plates with the active one's live state written back (for saving). */
  allPlates: () => { name: string; nodes: SceneNode[] }[];

  // Projects. Loading replaces everything and clears undo history.
  loadProject: (plates: { name: string; nodes: SceneNode[] }[], name: string) => void;
  setProjectName: (name: string) => void;
  markSaved: (name: string) => void;
}

const clone = <T,>(v: T): T => structuredClone(v);

/** Plates with the active plate's live objects and history written back. */
function stash(s: Pick<State, 'plates' | 'activePlate' | 'nodes' | 'past' | 'future'>): { plates: Plate[] } {
  return {
    plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, nodes: s.nodes, past: s.past, future: s.future } : p)),
  };
}
let counter = 0;
export const newId = () => `obj${Date.now().toString(36).slice(-4)}${(counter++).toString(36)}`;

const SETTINGS_KEY = 'fabbrico.settings';
const SCENE_KEY = 'fabbrico.scene';
const PROJECT_KEY = 'fabbrico.project';

function loadProjectInfo(): ProjectInfo {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (raw) return { name: 'untitled', dirty: false, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { name: 'untitled', dirty: false };
}

function loadSettings(): Settings {
  const defaults: Settings = {
    apiKey: '',
    model: 'claude-opus-5-5',
    effort: 'medium',
    printer: DEFAULT_PRINTER.id,
    bed: [...DEFAULT_PRINTER.bed],
    nozzle: DEFAULT_PRINTER.nozzle,
    overhangAngle: 45,
    theme: 'dark',
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Settings>;
    // Before printer presets the bed was fixed at 220 × 220 × 250, meant as the Bambu Lab A1 (really 256³).
    if (!saved.printer) {
      const old = saved.bed;
      if (!old || (old[0] === 220 && old[1] === 220 && old[2] === 250)) Object.assign(saved, { printer: DEFAULT_PRINTER.id, bed: [...DEFAULT_PRINTER.bed] });
      else saved.printer = CUSTOM;
    }
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

const PLATES_KEY = 'fabbrico.plates';
let plateCounter = 0;
const newPlateId = () => `plate${Date.now().toString(36).slice(-4)}${(plateCounter++).toString(36)}`;
const emptyPlate = (name: string, nodes: SceneNode[] = []): Plate => ({ id: newPlateId(), name, nodes, past: [], future: [] });

/** Plates saved in this browser; older versions only stored one scene. */
function loadPlates(): { plates: Plate[]; active: string } {
  try {
    const raw = localStorage.getItem(PLATES_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { plates: { id: string; name: string; nodes: SceneNode[] }[]; active: string };
      if (data.plates?.length) {
        const plates = data.plates.map((p) => ({ ...p, past: [], future: [] }));
        return { plates, active: plates.some((p) => p.id === data.active) ? data.active : plates[0].id };
      }
    }
    const legacy = localStorage.getItem(SCENE_KEY);
    if (legacy) {
      const plate = emptyPlate('Plate 1', JSON.parse(legacy));
      return { plates: [plate], active: plate.id };
    }
  } catch {
    /* ignore */
  }
  const plate = emptyPlate('Plate 1');
  return { plates: [plate], active: plate.id };
}
const initialPlates = loadPlates();

export function findNode(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.shape.kind === 'group') {
      const f = findNode(n.shape.children, id);
      if (f) return f;
    }
  }
  return null;
}

/** Deep copy of a node with fresh ids for it and all its descendants. */
export function cloneWithNewIds(node: SceneNode): SceneNode {
  const copy = clone(node);
  const renew = (n: SceneNode) => {
    n.id = newId();
    if (n.shape.kind === 'group') n.shape.children.forEach(renew);
  };
  renew(copy);
  return copy;
}

function mapNodes(nodes: SceneNode[], id: string, fn: (n: SceneNode) => SceneNode | null): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of nodes) {
    if (n.id === id) {
      const r = fn(n);
      if (r) out.push(r);
    } else if (n.shape.kind === 'group') {
      out.push({ ...n, shape: { ...n.shape, children: mapNodes(n.shape.children, id, fn) } });
    } else out.push(n);
  }
  return out;
}

export const useStore = create<State>((set, get) => ({
  nodes: initialPlates.plates.find((p) => p.id === initialPlates.active)!.nodes,
  plates: initialPlates.plates,
  activePlate: initialPlates.active,
  project: loadProjectInfo(),
  selectedId: null,
  gizmo: 'translate',
  overlay: 'none',
  picking: null,
  past: [],
  future: [],
  settings: loadSettings(),

  checkpoint: () =>
    set((s) => ({ past: [...s.past.slice(-99), clone(s.nodes)], future: [] })),
  undo: () =>
    set((s) => {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return { nodes: prev, past: s.past.slice(0, -1), future: [clone(s.nodes), ...s.future] };
    }),
  redo: () =>
    set((s) => {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { nodes: next, future: rest, past: [...s.past, clone(s.nodes)] };
    }),
  select: (id) => set({ selectedId: id }),
  setGizmo: (gizmo) => set({ gizmo }),
  setPicking: (picking) => set({ picking }),
  toggleOverlay: (o) => set((s) => ({ overlay: s.overlay === o ? 'none' : o })),
  setSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* ignore */
      }
      return { settings };
    }),

  addNode: (partial) => {
    const id = partial.id && !findNode(get().nodes, partial.id) ? partial.id : newId();
    const count = get().nodes.length;
    const node: SceneNode = {
      name: partial.shape.kind,
      color: PALETTE[count % PALETTE.length],
      hole: false,
      transform: identity(),
      modifiers: [],
      ...partial,
      id,
    };
    set((s) => ({ nodes: [...s.nodes, node], selectedId: id }));
    return id;
  },
  updateNode: (id, patch) =>
    set((s) => ({ nodes: mapNodes(s.nodes, id, (n) => ({ ...n, ...patch, id: n.id })) })),
  removeNodes: (ids) =>
    set((s) => {
      let nodes = s.nodes;
      for (const id of ids) nodes = mapNodes(nodes, id, () => null);
      return { nodes, selectedId: ids.includes(s.selectedId ?? '') ? null : s.selectedId };
    }),
  groupNodes: (ids, op, name) => {
    const { nodes } = get();
    const members = nodes.filter((n) => ids.includes(n.id));
    if (members.length < 2) return null;
    const id = newId();
    const group: SceneNode = {
      id,
      name: name ?? 'group',
      color: members.find((m) => !m.hole)?.color ?? PALETTE[0],
      hole: false,
      transform: identity(),
      modifiers: [],
      shape: { kind: 'group', op, children: members },
    };
    set({ nodes: [...nodes.filter((n) => !ids.includes(n.id)), group], selectedId: id });
    return id;
  },
  ungroup: (id) =>
    set((s) => {
      const g = s.nodes.find((n) => n.id === id);
      if (!g || g.shape.kind !== 'group') return s;
      // Only safe when the group itself has no transform/modifiers.
      return {
        nodes: [...s.nodes.filter((n) => n.id !== id), ...g.shape.children],
        selectedId: null,
      };
    }),
  duplicateNodes: (ids, opts = {}) => {
    const s = get();
    const [dx, dy, dz] = opts.offset ?? [0, 0, 0];
    const copies: SceneNode[] = [];
    for (const id of ids) {
      const src = findNode(s.nodes, id);
      if (!src) throw new Error(`No object with id ${id}`);
      const c = cloneWithNewIds(src);
      const [x, y, z] = c.transform.position;
      c.transform = { ...c.transform, position: [x + dx, y + dy, z + dz] };
      copies.push(c);
    }
    const target = opts.plateId ?? s.activePlate;
    if (target === s.activePlate) {
      set({ nodes: [...s.nodes, ...copies], selectedId: copies[copies.length - 1]?.id ?? s.selectedId });
    } else {
      if (!s.plates.some((p) => p.id === target)) throw new Error(`No plate with id ${target}`);
      set({
        plates: stash(s).plates.map((p) => (p.id === target ? { ...p, nodes: [...p.nodes, ...copies] } : p)),
        project: { ...s.project, dirty: true },
      });
    }
    return copies.map((c) => c.id);
  },
  pasteNodes: (nodes) => {
    const copies = nodes.map(cloneWithNewIds);
    set((s) => ({ nodes: [...s.nodes, ...copies], selectedId: copies[copies.length - 1]?.id ?? s.selectedId }));
    return copies.map((c) => c.id);
  },
  replaceScene: (nodes) => set({ nodes, selectedId: null }),

  addPlate: (name) => {
    const s = get();
    const used = new Set(s.plates.map((p) => p.name));
    let k = s.plates.length + 1;
    while (used.has(`Plate ${k}`)) k++;
    const plate = emptyPlate(name?.trim() || `Plate ${k}`);
    set({
      plates: [...stash(s).plates, plate],
      activePlate: plate.id,
      nodes: [],
      past: [],
      future: [],
      selectedId: null,
      project: { ...s.project, dirty: true },
    });
    return plate.id;
  },
  switchPlate: (id) =>
    set((s) => {
      if (id === s.activePlate) return s;
      const target = s.plates.find((p) => p.id === id);
      if (!target) return s;
      return { plates: stash(s).plates, activePlate: id, nodes: target.nodes, past: target.past, future: target.future, selectedId: null };
    }),
  renamePlate: (id, name) =>
    set((s) => ({
      plates: s.plates.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
      project: { ...s.project, dirty: true },
    })),
  removePlate: (id) =>
    set((s) => {
      if (s.plates.length < 2) return s;
      const plates = stash(s).plates.filter((p) => p.id !== id);
      if (id !== s.activePlate) return { plates, project: { ...s.project, dirty: true } };
      const next = plates[Math.max(0, s.plates.findIndex((p) => p.id === id) - 1)];
      return {
        plates,
        activePlate: next.id,
        nodes: next.nodes,
        past: next.past,
        future: next.future,
        selectedId: null,
        project: { ...s.project, dirty: true },
      };
    }),
  allPlates: () => stash(get()).plates.map((p) => ({ name: p.name, nodes: p.nodes })),

  loadProject: (plates, name) => {
    const list = (plates.length ? plates : [{ name: 'Plate 1', nodes: [] }]).map((p) => emptyPlate(p.name, p.nodes));
    set({
      plates: list,
      activePlate: list[0].id,
      nodes: list[0].nodes,
      project: { name, dirty: false },
      selectedId: null,
      past: [],
      future: [],
    });
  },
  setProjectName: (name) => set((s) => ({ project: { ...s.project, name: name.trim() || 'untitled' } })),
  markSaved: (name) => set({ project: { name, dirty: false } }),
}));

// Persist the scene locally so a refresh does not lose work.
useStore.subscribe((s, prev) => {
  if (s.nodes !== prev.nodes || s.plates !== prev.plates || s.activePlate !== prev.activePlate) {
    try {
      const plates = stash(s).plates.map(({ id, name, nodes }) => ({ id, name, nodes }));
      localStorage.setItem(PLATES_KEY, JSON.stringify({ plates, active: s.activePlate }));
    } catch {
      /* ignore */
    }
  }
  // An edit on the plate (not a load or a plate switch, which change other state too) makes the project dirty.
  if (s.nodes !== prev.nodes && s.project === prev.project && s.activePlate === prev.activePlate && !s.project.dirty)
    useStore.setState({ project: { ...s.project, dirty: true } });
  if (s.project !== prev.project) {
    try {
      localStorage.setItem(PROJECT_KEY, JSON.stringify(useStore.getState().project));
    } catch {
      /* ignore */
    }
  }
});

export function addPrimitive(kind: Exclude<ShapeKind, 'group'>) {
  const st = useStore.getState();
  st.checkpoint();
  const shape: LeafShape = defaultShape(kind);
  // Offset new objects so they do not all overlap.
  const n = st.nodes.length;
  const pos: [number, number, number] = [((n % 4) - 1.5) * 30, (Math.floor(n / 4) % 3) * 30 - 30, 0];
  return st.addNode({ shape, name: kind === 'polygon' ? 'triangle' : kind, transform: { ...identity(), position: pos } });
}
