import type { Manifold } from 'manifold-3d/manifold';

/** Render-ready mesh in a node's local frame. Plain typed arrays, so it can cross the worker boundary. */
export interface MeshData {
  position: Float32Array;
  /** Crease-aware normals, or null to let three.js compute smooth ones. */
  normal: Float32Array | null;
  index: Uint32Array;
}

/** Manifold -> mesh arrays with crease-aware normals (runs in the geometry worker). */
export function toMeshData(m: Manifold): MeshData {
  // Faces meeting at more than 30° get a hard edge (keeps 45° chamfers crisp, curved surfaces smooth).
  const withNormals = m.calculateNormals(0, 30);
  const mesh = withNormals.getMesh(0);
  withNormals.delete();
  const np = mesh.numProp;
  const n = mesh.vertProperties.length / np;
  const position = new Float32Array(n * 3);
  const normal = np >= 6 ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    position[i * 3] = mesh.vertProperties[i * np];
    position[i * 3 + 1] = mesh.vertProperties[i * np + 1];
    position[i * 3 + 2] = mesh.vertProperties[i * np + 2];
    if (normal) {
      normal[i * 3] = mesh.vertProperties[i * np + 3];
      normal[i * 3 + 1] = mesh.vertProperties[i * np + 4];
      normal[i * 3 + 2] = mesh.vertProperties[i * np + 5];
    }
  }
  return { position, normal, index: new Uint32Array(mesh.triVerts) };
}

/** Plain triangle soup (positions + indices) in world space, for export/analysis. */
export function toTriangles(m: Manifold) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const n = mesh.vertProperties.length / np;
  const verts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    verts[i * 3] = mesh.vertProperties[i * np];
    verts[i * 3 + 1] = mesh.vertProperties[i * np + 1];
    verts[i * 3 + 2] = mesh.vertProperties[i * np + 2];
  }
  return { verts, tris: mesh.triVerts };
}
