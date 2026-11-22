// AR preview for a phone or tablet: the current plate as a USDZ model at real
// size, opened on the device with Apple's AR Quick Look (no app needed).
// Built here, uploaded to the dev server (server/padRelay.ts), which serves it
// to the device from an unguessable address for 30 minutes.

import { Group, Mesh, MeshStandardMaterial, Box3, Vector3 } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { useStore } from '../model/store';
import { geometry } from '../geometry/client';

/** Builds the USDZ of the current plate and returns the path the device should open. */
export async function makeArPreview(): Promise<{ path: string; plate: string; objects: number }> {
  const st = useStore.getState();
  const plate = st.plates.find((p) => p.id === st.activePlate)?.name ?? '';
  const solids = st.nodes.filter((n) => !n.hole);
  if (!solids.length) throw new Error(`The plate "${plate}" is empty`);

  // One mesh per object, so each keeps its colour. Fabbrico works in mm with Z up;
  // USDZ here is in metres with Y up.
  const root = new Group();
  const loader = new STLLoader();
  for (const node of solids) {
    const stl = await geometry.exportBytes([node], 'stl');
    const geo = loader.parse((stl as Uint8Array).slice().buffer as ArrayBuffer);
    geo.computeVertexNormals();
    root.add(new Mesh(geo, new MeshStandardMaterial({ color: node.color, roughness: 0.55, metalness: 0 })));
  }
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(0.001);
  root.updateMatrixWorld(true);
  // Centre it over the origin, resting on the floor: that is where Quick Look places it.
  const box = new Box3().setFromObject(root);
  const c = box.getCenter(new Vector3());
  root.position.set(-c.x, -box.min.y, -c.z);

  const scene = new Group();
  scene.add(root);
  const bytes = await new USDZExporter().parseAsync(scene, {
    quickLookCompatible: true,
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
  });
  for (const m of root.children as Mesh[]) {
    m.geometry.dispose();
    (m.material as MeshStandardMaterial).dispose();
  }

  const res = await fetch('/pad-api/ar-upload', {
    method: 'POST',
    headers: { 'X-Fabbrico': '1', 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Could not prepare the AR file (${res.status})`);
  const { path } = (await res.json()) as { path: string };
  return { path, plate, objects: solids.length };
}
