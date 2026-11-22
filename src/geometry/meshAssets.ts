// Imported meshes known to the geometry worker, by asset id. The main thread
// sends each one once (see client.ts) before the first request that needs it.

import type { MeshAsset } from '../model/assets';

const meshes = new Map<string, MeshAsset>();

export function registerMesh(id: string, asset: MeshAsset) {
  meshes.set(id, asset);
}

export function meshAsset(id: string): MeshAsset | undefined {
  return meshes.get(id);
}
