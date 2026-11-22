// Binary assets referenced by the scene (imported meshes). The scene only
// stores an asset id; the data lives here, in IndexedDB (no 5 MB localStorage
// limit), and inside project files when saving.

export interface MeshAsset {
  /** xyz per vertex, mm, already welded (shared vertices). */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

const memory = new Map<string, MeshAsset>();

// ------------------------------------------------------------ IndexedDB ----

// Database name kept from the app's former name (Forma), so data saved before the rename stays.
const DB = 'forma';
const STORE = 'assets';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --------------------------------------------------------------- public ----

/** Raw key-value access to the same IndexedDB store, for other project data (e.g. photos). */
export async function idbGet<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>('readonly', (s) => s.get(key));
}
export async function idbPut(key: string, value: unknown): Promise<void> {
  await tx('readwrite', (s) => s.put(value, key));
}

export function getAsset(id: string): MeshAsset | undefined {
  return memory.get(id);
}

/** Store a mesh and return its id (a hash of its content, so the same mesh is stored once). */
export async function putAsset(asset: MeshAsset): Promise<string> {
  const bytes = encode(asset);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = 'mesh-' + [...hash.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!memory.has(id)) {
    memory.set(id, asset);
    try {
      await tx('readwrite', (s) => s.put(bytes, id));
    } catch {
      /* private mode etc.: still works for this session */
    }
  }
  return id;
}

/** Load assets from IndexedDB into memory. Returns the ids that could not be found. */
export async function loadAssets(ids: Iterable<string>): Promise<string[]> {
  const missing: string[] = [];
  for (const id of ids) {
    if (memory.has(id)) continue;
    try {
      const bytes = await tx<ArrayBuffer | undefined>('readonly', (s) => s.get(id));
      if (bytes) memory.set(id, decode(new Uint8Array(bytes)));
      else missing.push(id);
    } catch {
      missing.push(id);
    }
  }
  return missing;
}

/** Forget stored meshes that nothing references any more (other entries in the store are left alone). */
export async function pruneAssets(keep: Set<string>) {
  for (const id of [...memory.keys()]) if (!keep.has(id)) memory.delete(id);
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    for (const k of keys)
      if (typeof k === 'string' && k.startsWith('mesh-') && !keep.has(k)) await tx('readwrite', (s) => s.delete(k));
  } catch {
    /* ignore */
  }
}

/** Add assets from a project file. */
export function registerAssets(entries: Record<string, string>) {
  for (const [id, b64] of Object.entries(entries)) {
    if (memory.has(id)) continue;
    const asset = decode(fromBase64(b64));
    memory.set(id, asset);
    void tx('readwrite', (s) => s.put(encode(asset), id)).catch(() => {});
  }
}

/** Assets to embed in a project file. */
export function exportAssets(ids: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const a = memory.get(id);
    if (a) out[id] = toBase64(encode(a));
  }
  return out;
}

// ------------------------------------------------------------- encoding ----

/** [vertexCount u32][triangleCount u32][positions f32…][indices u32…] */
export function encode(a: MeshAsset): Uint8Array<ArrayBuffer> {
  const nv = a.positions.length / 3, nt = a.indices.length / 3;
  const buf = new ArrayBuffer(8 + a.positions.byteLength + a.indices.byteLength);
  const head = new Uint32Array(buf, 0, 2);
  head[0] = nv;
  head[1] = nt;
  new Float32Array(buf, 8, nv * 3).set(a.positions);
  new Uint32Array(buf, 8 + nv * 12, nt * 3).set(a.indices);
  return new Uint8Array(buf);
}

export function decode(bytes: Uint8Array): MeshAsset {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const [nv, nt] = new Uint32Array(buf, 0, 2);
  return { positions: new Float32Array(buf, 8, nv * 3), indices: new Uint32Array(buf, 8 + nv * 12, nt * 3) };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
