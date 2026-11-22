// Import of external meshes (STL, OBJ, glTF/GLB, 3MF) as "mesh" objects.
// Parsing happens here with three.js loaders; the welded mesh becomes an asset
// (see model/assets.ts) and the object references it by id.

import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { putAsset, type MeshAsset } from '../model/assets';
import { useStore } from '../model/store';
import { identity } from '../model/schema';
import { geometry } from '../geometry/client';

export const MESH_EXTENSIONS = ['.stl', '.obj', '.glb', '.gltf', '.3mf'];
const MAX_TRIANGLES = 1_000_000;

export function pickMeshFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MESH_EXTENSIONS.join(',');
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export const isMeshFile = (name: string) => MESH_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));

/** Collect all triangles of a loaded object (world transforms applied) as a flat soup. */
function soupOf(obj: THREE.Object3D): Float32Array {
  obj.updateMatrixWorld(true);
  const parts: Float32Array[] = [];
  let total = 0;
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    let g = mesh.geometry as THREE.BufferGeometry;
    if (g.index) g = g.toNonIndexed();
    const pos = g.attributes.position;
    const out = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.set([v.x, v.y, v.z], i * 3);
    }
    // A mirroring transform flips the winding: flip it back.
    if (mesh.matrixWorld.determinant() < 0)
      for (let t = 0; t < out.length; t += 9)
        for (let k = 0; k < 3; k++) [out[t + 3 + k], out[t + 6 + k]] = [out[t + 6 + k], out[t + 3 + k]];
    parts.push(out);
    total += out.length;
  });
  const soup = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    soup.set(p, o);
    o += p.length;
  }
  return soup;
}

/** Weld identical vertices (within a tiny tolerance) and drop degenerate triangles. */
function weld(soup: Float32Array): MeshAsset {
  let maxAbs = 1e-9;
  for (const v of soup) maxAbs = Math.max(maxAbs, Math.abs(v));
  const q = maxAbs * 1e-6; // quantum
  const map = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const idx = new Array<number>(3);
  for (let t = 0; t < soup.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const x = soup[t + k * 3], y = soup[t + k * 3 + 1], z = soup[t + k * 3 + 2];
      const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
      let i = map.get(key);
      if (i === undefined) {
        i = positions.length / 3;
        positions.push(x, y, z);
        map.set(key, i);
      }
      idx[k] = i;
    }
    if (idx[0] !== idx[1] && idx[1] !== idx[2] && idx[0] !== idx[2]) indices.push(idx[0], idx[1], idx[2]);
  }
  const out = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  // Some exporters write the triangles inside out: fix it if the enclosed volume comes out negative.
  if (signedVolume(out) < 0)
    for (let t = 0; t < out.indices.length; t += 3) [out.indices[t + 1], out.indices[t + 2]] = [out.indices[t + 2], out.indices[t + 1]];
  return out;
}

function signedVolume({ positions: p, indices: ix }: MeshAsset) {
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

async function parse(file: File): Promise<{ object: THREE.Object3D; yUp: boolean }> {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.stl')) return { object: new THREE.Mesh(new STLLoader().parse(buf)), yUp: false };
  if (name.endsWith('.3mf')) return { object: new ThreeMFLoader().parse(buf), yUp: false };
  if (name.endsWith('.obj')) return { object: new OBJLoader().parse(new TextDecoder().decode(buf)), yUp: true };
  if (name.endsWith('.glb') || name.endsWith('.gltf')) {
    const gltf = await new GLTFLoader().parseAsync(name.endsWith('.gltf') ? new TextDecoder().decode(buf) : buf, '');
    return { object: gltf.scene, yUp: true };
  }
  throw new Error(`Unsupported file type. Fabbrico imports ${MESH_EXTENSIONS.join(', ')}.`);
}

/**
 * Import a mesh file as a new object. glTF and OBJ are Y-up and turned Z-up.
 * The mesh is centred on the Z axis and set on the bed. Models that look like
 * they are in metres or normalised (< 2 units) or don't fit the bed are scaled
 * to a sensible size; the returned note says so.
 */
export async function importMeshFile(file: File): Promise<string | null> {
  const { object, yUp } = await parse(file);
  if (yUp) object.rotation.x = Math.PI / 2;
  const soup = soupOf(object);
  if (!soup.length) throw new Error('No triangles found in this file.');
  if (soup.length / 9 > MAX_TRIANGLES) throw new Error(`Too many triangles (${Math.round(soup.length / 9).toLocaleString()}); the limit is ${MAX_TRIANGLES.toLocaleString()}. Simplify it first.`);

  // Centre on the Z axis, bottom on z = 0 (like Fabbrico's primitives).
  const box = new THREE.Box3();
  for (let i = 0; i < soup.length; i += 3) box.expandByPoint(new THREE.Vector3(soup[i], soup[i + 1], soup[i + 2]));
  const c = box.getCenter(new THREE.Vector3());
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] -= c.x;
    soup[i + 1] -= c.y;
    soup[i + 2] -= box.min.z;
  }
  const asset = weld(soup);
  const id = await putAsset(asset);

  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const st = useStore.getState();
  const bed = st.settings.bed;
  let scale = 1;
  let note: string | null = null;
  if (longest < 2) {
    scale = 60 / longest;
    note = `"${file.name}" is only ${longest.toPrecision(2)} units big (probably metres or normalised): scaled to 60 mm. Change the scale in the inspector if needed.`;
  } else if (size.x > bed[0] || size.y > bed[1] || size.z > bed[2]) {
    scale = 0.9 * Math.min(bed[0] / size.x, bed[1] / size.y, bed[2] / size.z);
    note = `"${file.name}" was bigger than the bed: scaled to ${Math.round(scale * 100)}%.`;
  }
  const r = (v: number) => Math.round(v * 1000) / 1000;
  st.checkpoint();
  const nodeId = st.addNode({
    name: file.name.replace(/\.[^.]+$/, ''),
    shape: { kind: 'mesh', asset: id, triangles: asset.indices.length / 3 },
    transform: { ...identity(), scale: [r(scale), r(scale), r(scale)] },
  });
  // Check it is a usable solid now, rather than leaving an invisible broken object.
  try {
    const node = useStore.getState().nodes.find((n) => n.id === nodeId);
    if (node) await geometry.bounds(node);
  } catch (e) {
    useStore.getState().undo();
    throw e;
  }
  return note;
}
