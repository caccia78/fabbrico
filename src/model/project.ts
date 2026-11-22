// Project files (.fabbrico): the plates (each a scene JSON tree) plus a little metadata.
// Pretty-printed JSON so projects are readable and diff well in git.
//
// Where the File System Access API exists (Chrome, Edge) we keep the file
// handle so ⌘S writes back to the same file; elsewhere Save downloads a copy
// and Open uses a file input.

import { z } from 'zod/v4';
import { meshAssetsOf, SceneNodeSchema, type SceneNode } from './schema';
import { exportAssets, registerAssets } from './assets';
import { useStore } from './store';
import { NoteSchema, ReferenceSchema, setReferences, useReferences, type Note, type Reference } from './references';
import { diaryForFile, DiarySchema, setDiary, useDiary, type Diary } from './diary';
import { LEGACY_PROJECT_EXT, LEGACY_PROJECT_FORMAT } from '../legacy';

export const PROJECT_EXT = '.fabbrico';
const FORMAT = 'fabbrico-project';
// v1: a single `scene`. v2: `plates`, each with a name and a scene.
const VERSION = 2;

const ProjectFile = z.object({
  format: z.enum([FORMAT, LEGACY_PROJECT_FORMAT]),
  version: z.number().int().min(1),
  name: z.string().optional(),
  savedAt: z.string().optional(),
  scene: z.array(SceneNodeSchema).optional(),
  plates: z.array(z.object({ name: z.string(), scene: z.array(SceneNodeSchema) })).optional(),
  /** Imported meshes by asset id, base64 of the binary encoding in assets.ts. */
  assets: z.record(z.string(), z.string()).optional(),
  /** Reference photos (see references.ts). */
  references: z.array(ReferenceSchema).optional(),
  /** Written notes, e.g. measurements (see references.ts). */
  notes: z.array(NoteSchema).optional(),
  /** Project diary: print attempts and proposed experiences (see diary.ts). */
  diary: DiarySchema.optional(),
});

export interface PlateData {
  name: string;
  nodes: SceneNode[];
}

// Minimal typings: the File System Access API is not in TypeScript's DOM lib.
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
type PickerTypes = { types: { description: string; accept: Record<string, string[]> }[] };
interface FsWindow {
  showSaveFilePicker?: (o: PickerTypes & { suggestedName?: string }) => Promise<FileHandle>;
  showOpenFilePicker?: (o: PickerTypes & { multiple?: boolean }) => Promise<FileHandle[]>;
}
const fsWin = window as unknown as FsWindow;
const PICKER: PickerTypes = {
  types: [{ description: 'Fabbrico project', accept: { 'application/json': [PROJECT_EXT, LEGACY_PROJECT_EXT] } }],
};

/** Handle of the file the current project was opened from / saved to (lost on reload). */
let handle: FileHandle | null = null;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const baseName = (file: string) => file.replace(/\.(fabbrico|forma)$/i, '').replace(/\.json$/i, '') || 'untitled';
const safeFileName = (name: string) => (name.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'untitled') + PROJECT_EXT;

export function serializeProject(plates: PlateData[], name: string, references: Reference[] = [], notes: Note[] = [], diary?: Diary): string {
  return JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      name,
      savedAt: new Date().toISOString(),
      plates: plates.map((p) => ({ name: p.name, scene: p.nodes })),
      assets: exportAssets(meshAssetsOf(plates.flatMap((p) => p.nodes))),
      ...(references.length ? { references } : {}),
      ...(notes.length ? { notes } : {}),
      ...(diary ? { diary } : {}),
    },
    null,
    2,
  );
}

export function parseProject(text: string): {
  name?: string;
  plates: PlateData[];
  assets: Record<string, string>;
  references: Reference[];
  notes: Note[];
  diary?: Diary;
} {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || ![FORMAT, LEGACY_PROJECT_FORMAT].includes((data as { format?: unknown }).format as string))
    throw new Error('This is not a Fabbrico project file.');
  const parsed = ProjectFile.safeParse(data);
  if (!parsed.success) throw new Error(`The project file is damaged:\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.version > VERSION)
    throw new Error('This project was saved by a newer version of Fabbrico. Update Fabbrico to open it.');
  const { name, scene, plates, assets = {}, references = [], notes = [], diary } = parsed.data;
  if (plates?.length) return { name, assets, references, notes, diary, plates: plates.map((p) => ({ name: p.name, nodes: p.scene })) };
  if (scene) return { name, assets, references, notes, diary, plates: [{ name: 'Plate 1', nodes: scene }] };
  throw new Error('The project file has no plates.');
}

function confirmDiscard(): boolean {
  return !useStore.getState().project.dirty || confirm('Discard unsaved changes to the current project?');
}

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save the project. Returns false if the user cancelled. */
export async function saveProject({ saveAs = false } = {}): Promise<boolean> {
  const st = useStore.getState();
  const name = st.project.name;
  const { list: refs, notes } = useReferences.getState();
  const diary = useDiary.getState();
  const text = serializeProject(st.allPlates(), name, refs, notes, diaryForFile());
  // Writing the file takes a moment: only mark it clean if nothing changed meanwhile.
  const unchanged = () => {
    const now = useStore.getState();
    return (
      now.nodes === st.nodes && now.plates === st.plates && now.activePlate === st.activePlate && useReferences.getState().list === refs &&
      useReferences.getState().notes === notes &&
      useDiary.getState().attempts === diary.attempts &&
      useDiary.getState().proposals === diary.proposals
    );
  };
  try {
    if (fsWin.showSaveFilePicker) {
      if (!handle || saveAs) handle = await fsWin.showSaveFilePicker({ ...PICKER, suggestedName: safeFileName(name) });
      const w = await handle.createWritable();
      await w.write(new Blob([text], { type: 'application/json' }));
      await w.close();
      const fileName = baseName(handle.name);
      if (unchanged()) useStore.getState().markSaved(fileName);
      else useStore.getState().setProjectName(fileName);
    } else {
      download(text, safeFileName(name));
      if (unchanged()) useStore.getState().markSaved(name);
    }
    return true;
  } catch (e) {
    if (isAbort(e)) return false;
    throw e;
  }
}

/** Open a project from a file (picker or drag and drop). Throws if the file is not a valid project. */
export async function openProjectFile(file: File, fileHandle: FileHandle | null = null, confirmed = false) {
  const { name, plates, assets, references, notes, diary } = parseProject(await file.text());
  if (!confirmed && !confirmDiscard()) return;
  registerAssets(assets);
  handle = fileHandle;
  useStore.getState().loadProject(plates, name || baseName(file.name));
  setReferences(references, notes);
  setDiary(diary);
}

/** Show a file picker and open the chosen project. */
export async function openProject() {
  if (!confirmDiscard()) return;
  if (fsWin.showOpenFilePicker) {
    try {
      const [h] = await fsWin.showOpenFilePicker(PICKER);
      await openProjectFile(await h.getFile(), h, true);
    } catch (e) {
      if (!isAbort(e)) throw e;
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${PROJECT_EXT},${LEGACY_PROJECT_EXT},application/json`;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve();
      openProjectFile(f, null, true).then(resolve, reject);
    };
    input.click();
  });
}

export function newProject() {
  if (!confirmDiscard()) return;
  handle = null;
  useStore.getState().loadProject([], 'untitled');
  setReferences([]);
  setDiary();
}
