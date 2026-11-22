// Export to 3MF (preferred: keeps the solid watertight and carries units)
// and binary STL (for older slicers). Runs in the geometry worker; the main
// thread downloads the bytes (see client.ts).

import { strToU8, zipSync } from 'fflate';
import type { SceneNode } from '../model/schema';
import { buildPrintable } from './kernel';
import { toTriangles } from './convert';

export function build3MF(nodes: SceneNode[]): Uint8Array {
  const m = buildPrintable(nodes);
  const { verts, tris } = toTriangles(m);
  m.delete();
  const v: string[] = [];
  for (let i = 0; i < verts.length; i += 3)
    v.push(`<vertex x="${verts[i]}" y="${verts[i + 1]}" z="${verts[i + 2]}"/>`);
  const t: string[] = [];
  for (let i = 0; i < tris.length; i += 3)
    t.push(`<triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>`);

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">Fabbrico</metadata>
<resources><object id="1" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object></resources>
<build><item objectid="1"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
}

export function buildSTL(nodes: SceneNode[]): ArrayBuffer {
  const m = buildPrintable(nodes);
  const { verts, tris } = toTriangles(m);
  m.delete();
  const count = tris.length / 3;
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, count, true);
  let o = 84;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const val of [nx, ny, nz]) { dv.setFloat32(o, val, true); o += 4; }
    for (const idx of [a, b, c])
      for (let k = 0; k < 3; k++) { dv.setFloat32(o, verts[idx + k], true); o += 4; }
    o += 2;
  }
  return buf;
}
