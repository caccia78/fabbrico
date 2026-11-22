import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../model/store';
import type { SceneNode } from '../model/schema';
import { cachedMesh, geometry as geometryWorker, geometryKey, GeometryCancelled, thicknessKey } from '../geometry/client';

const thicknessOf = (node: SceneNode, slot: string) => geometryWorker.thickness(node, slot);
import type { MeshData } from '../geometry/convert';
import type { ThicknessData } from '../geometry/thickness';
import { thicknessColor } from './thicknessScale';
import { viewportApi, type ViewName } from './viewportApi';
import { SCENE_COLORS, useResolvedTheme } from './theme';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const DEG = Math.PI / 180;

function nodeMatrix(n: SceneNode) {
  const e = new THREE.Euler(...n.transform.rotation.map((d) => d * DEG) as [number, number, number], 'ZYX');
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...n.transform.position),
    new THREE.Quaternion().setFromEuler(e),
    new THREE.Vector3(...n.transform.scale),
  );
}

/** Path of nodes from a root down to `id` (inclusive), or null. */
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

/**
 * Finish a "pick a face" request: convert the clicked point and normal into
 * the local frame of the node that owns the modifier (which may sit inside the
 * clicked root group) and store them as the modifier's region.
 */
function pickFace(root: SceneNode, mesh: THREE.Object3D, worldPoint: THREE.Vector3, localNormal: THREE.Vector3) {
  const st = useStore.getState();
  const req = st.picking;
  if (!req) return;
  const path = pathTo(st.nodes, req.nodeId);
  if (!path || path[0].id !== root.id) return; // clicked another object: keep waiting
  // Root mesh local frame -> target local frame through the group children's transforms.
  let point = mesh.worldToLocal(worldPoint.clone());
  let normal = localNormal.clone();
  for (const n of path.slice(1)) {
    const inv = nodeMatrix(n).invert();
    point = point.applyMatrix4(inv);
    normal = normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(inv)).normalize();
  }
  const target = path[path.length - 1];
  const mod = target.modifiers[req.modIndex];
  if (!mod || mod.type !== 'displace') return;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const region = {
    point: [r3(point.x), r3(point.y), r3(point.z)] as [number, number, number],
    normal: [r3(normal.x), r3(normal.y), r3(normal.z)] as [number, number, number],
    angle: mod.region?.angle ?? 30,
  };
  st.checkpoint();
  st.updateNode(target.id, { modifiers: target.modifiers.map((m, j) => (j === req.modIndex ? { ...mod, faces: 'picked' as const, region } : m)) });
  st.setPicking(null);
}

function toBufferGeometry(d: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  if (d.normal) g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  else g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Geometry of a node, built in the worker. While a new version is computing the
 * previous one stays on screen; if a build fails, the last good one is kept.
 */
function useNodeGeometry(node: SceneNode) {
  const key = geometryKey(node);
  const [state, setState] = useState<{ key: string; geometry: THREE.BufferGeometry | null }>(() => {
    const hit = cachedMesh(key);
    return { key, geometry: hit ? toBufferGeometry(hit) : null };
  });
  const nodeRef = useRef(node);
  useEffect(() => {
    nodeRef.current = node; // runs before the build effect below
  });

  useEffect(() => {
    if (state.key === key && state.geometry) return;
    let live = true;
    geometryWorker.mesh(nodeRef.current, nodeRef.current.id).then(
      (data) => {
        if (live) setState({ key, geometry: toBufferGeometry(data) });
      },
      (e: Error) => {
        if (!live || e instanceof GeometryCancelled) return;
        console.warn(`[fabbrico] ${nodeRef.current.name}: ${e.message}`);
      },
    );
    return () => {
      live = false;
    };
  }, [key, state.key, state.geometry]);

  // Free GPU buffers of geometries we no longer show.
  useEffect(() => () => state.geometry?.dispose(), [state.geometry]);

  return state.geometry;
}

function overhangColors(geom: THREE.BufferGeometry, node: SceneNode, angle: number, base: string) {
  const m = nodeMatrix(node);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const pos = geom.getAttribute('position');
  const nor = geom.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  let minZ = Infinity;
  for (let i = 0; i < pos.count; i++) minZ = Math.min(minZ, p.fromBufferAttribute(pos, i).applyMatrix4(m).z);
  const limit = Math.cos((90 - angle - 0.5) * DEG); // same tolerance as analysis.ts
  const ok = new THREE.Color(base), bad = new THREE.Color('#ff3b30'), warn = new THREE.Color('#ffb020');
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(m);
    n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
    const down = -n.z;
    const c = p.z < minZ + 0.05 ? ok : down > limit ? bad : down > limit * 0.75 ? warn : ok;
    colors.set([c.r, c.g, c.b], i * 3);
  }
  return colors;
}

/** Thickness data of a node while the Thickness view is on (null until computed). */
function useThickness(node: SceneNode, enabled: boolean) {
  const key = thicknessKey(node);
  const [state, setState] = useState<{ key: string; data: ThicknessData } | null>(null);
  const nodeRef = useRef(node);
  useEffect(() => {
    nodeRef.current = node;
  });
  useEffect(() => {
    if (!enabled || node.hole || state?.key === key) return;
    let live = true;
    thicknessOf(nodeRef.current, nodeRef.current.id).then(
      (data) => {
        if (live) setState({ key, data });
      },
      (e: Error) => {
        if (live && !(e instanceof GeometryCancelled)) console.warn(`[fabbrico] thickness of ${nodeRef.current.name}: ${e.message}`);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, key, node.hole, state?.key]);
  // Show the last result while a newer one computes, like the normal geometry.
  return enabled ? (state?.data ?? null) : null;
}

function thicknessGeometry(d: ThicknessData, nozzle: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  const colors = new Float32Array(d.position.length);
  const c = new THREE.Color();
  for (let t = 0; t < d.thickness.length; t++) {
    c.set(thicknessColor(d.thickness[t], nozzle));
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], t * 9 + k * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function NodeMesh({ node, selected }: { node: SceneNode; selected: boolean }) {
  const geometry = useNodeGeometry(node);
  const select = useStore((s) => s.select);
  const overlay = useStore((s) => s.overlay);
  const angle = useStore((s) => s.settings.overhangAngle);
  const nozzle = useStore((s) => s.settings.nozzle);
  const thickness = useThickness(node, overlay === 'thickness');

  const thick = useMemo(() => (thickness ? thicknessGeometry(thickness, nozzle) : null), [thickness, nozzle]);
  useEffect(() => () => thick?.dispose(), [thick]);

  const colored = useMemo(() => {
    if (!geometry || overlay !== 'overhangs' || node.hole) return geometry;
    const g = geometry.clone();
    g.setAttribute('color', new THREE.BufferAttribute(overhangColors(geometry, node, angle, node.color), 3));
    return g;
  }, [geometry, overlay, node, angle]);

  const vertexColors = (overlay === 'overhangs' || (overlay === 'thickness' && !!thick)) && !node.hole;
  const shown = overlay === 'thickness' && thick && !node.hole ? thick : colored;

  // Does part of the object sink below the bed? Then it gets a red overlay there.
  const sinks = useMemo(() => {
    if (!shown || node.hole || !shown.boundingBox) return false;
    return shown.boundingBox.clone().applyMatrix4(nodeMatrix(node)).min.z < -0.01;
  }, [shown, node]);

  if (!shown) return null;
  const t = node.transform;
  return (
    <mesh
      name={node.id}
      userData={{ nodeId: node.id }}
      geometry={shown}
      position={t.position}
      rotation={new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'ZYX')}
      scale={t.scale}
      castShadow
      receiveShadow
      onClick={(e) => {
        e.stopPropagation();
        if (useStore.getState().picking) {
          if (e.face) pickFace(node, e.object, e.point, e.face.normal);
          return;
        }
        select(node.id);
      }}
    >
      {node.hole ? (
        <meshStandardMaterial color="#ff4d4d" transparent opacity={0.3} depthWrite={false} />
      ) : (
        <meshStandardMaterial
          key={vertexColors ? 'analysis' : 'plain'}
          color={vertexColors ? '#ffffff' : node.color}
          vertexColors={vertexColors}
          roughness={0.55}
          metalness={0.05}
          emissive={selected ? '#3355aa' : '#000000'}
          emissiveIntensity={selected ? 0.35 : 0}
        />
      )}
      {sinks && (
        // Same geometry clipped to z < 0, pulled slightly towards the camera: tints what's below the bed.
        <mesh geometry={shown} raycast={() => null} renderOrder={1}>
          <meshBasicMaterial
            color="#ff3b30"
            transparent
            opacity={0.55}
            clippingPlanes={BELOW_BED}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}
    </mesh>
  );
}

/** Keeps only what lies below the bed (z < 0), in world space. */
const BELOW_BED = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];

function Gizmo() {
  const selectedId = useStore((s) => s.selectedId);
  const mode = useStore((s) => s.gizmo);
  const isRoot = useStore((s) => s.nodes.some((n) => n.id === s.selectedId));
  const scene = useThree((s) => s.scene);
  const [obj, setObj] = useState<THREE.Object3D | undefined>();
  // The mesh may mount after this component renders, so look it up each frame.
  useFrame(() => {
    const found = selectedId && isRoot ? scene.getObjectByName(selectedId) : undefined;
    if (found !== obj) setObj(found);
  });
  if (!obj) return null;
  return (
    <TransformControls
      object={obj}
      mode={mode}
      size={0.8}
      onMouseUp={() => {
        const st = useStore.getState();
        const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'ZYX');
        const r = (v: number) => Math.round(v * 1000) / 1000;
        st.checkpoint();
        st.updateNode(obj.name, {
          transform: {
            position: [r(obj.position.x), r(obj.position.y), r(obj.position.z)],
            rotation: [r(e.x / DEG), r(e.y / DEG), r(e.z / DEG)],
            scale: [r(obj.scale.x), r(obj.scale.y), r(obj.scale.z)],
          },
        });
      }}
    />
  );
}

const VIEW_DIRS: Record<Exclude<ViewName, 'current'>, [number, number, number]> = {
  iso: [1, -1.2, 0.9],
  top: [0.0001, -0.0001, 1],
  bottom: [0.0001, 0.0001, -1],
  front: [0, -1, 0.0001],
  back: [0, 1, 0.0001],
  right: [1, 0, 0.0001],
  left: [-1, 0, 0.0001],
};

/** Lets the AI agent request snapshots from arbitrary viewpoints. */
function CaptureBridge() {
  const { gl, scene, camera, size } = useThree();
  useEffect(() => {
    viewportApi.register((view, focusId) => {
      let cam: THREE.Camera = camera;
      if (view !== 'current' || focusId) {
        const box = new THREE.Box3();
        scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && o.userData.nodeId && (!focusId || o.userData.nodeId === focusId))
            box.expandByObject(o);
        });
        if (box.isEmpty()) box.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 20));
        const center = box.getCenter(new THREE.Vector3());
        const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 20;
        const pc = new THREE.PerspectiveCamera(35, size.width / size.height, 0.1, 5000);
        const dir = new THREE.Vector3(...VIEW_DIRS[view === 'current' ? 'iso' : view]).normalize();
        pc.position.copy(center).addScaledVector(dir, (radius / Math.sin((35 * DEG) / 2)) * 1.1);
        pc.up.set(0, 0, 1);
        pc.lookAt(center);
        cam = pc;
      }
      gl.render(scene, cam);
      const src = gl.domElement;
      const scale = Math.min(1, 1024 / Math.max(src.width, src.height));
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
      if (cam !== camera) gl.render(scene, camera);
      return c.toDataURL('image/jpeg', 0.85).split(',')[1];
    });
    return () => viewportApi.register(null);
  }, [gl, scene, camera, size]);
  return null;
}

export function Viewport() {
  const nodes = useStore((s) => s.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const bed = useStore((s) => s.settings.bed);
  const volume = useMemo(() => new THREE.BoxGeometry(bed[0], bed[1], bed[2]), [bed]);
  useEffect(() => () => volume.dispose(), [volume]);
  const select = useStore((s) => s.select);
  const orbit = useRef(null);
  const colors = SCENE_COLORS[useResolvedTheme()];

  return (
    <Canvas
      shadows
      // localClippingEnabled: per-material clipping planes, used by the below-the-bed overlay.
      gl={{ preserveDrawingBuffer: true, antialias: true, localClippingEnabled: true }}
      camera={{ position: [110, -150, 110], fov: 35, near: 0.1, far: 5000 }}
      onPointerMissed={() => select(null)}
    >
      <color attach="background" args={[colors.background]} />
      <hemisphereLight args={['#ffffff', colors.ground, 0.9]} />
      <directionalLight position={[80, -60, 160]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-100, 80, 60]} intensity={0.5} />

      {/* Print bed. Drawn first and without depth, so it never hides parts that sink below it. */}
      <mesh position={[0, 0, -0.05]} receiveShadow renderOrder={-1}>
        <planeGeometry args={[bed[0], bed[1]]} />
        <meshStandardMaterial color={colors.bed} depthWrite={false} />
      </mesh>
      <Grid
        rotation={[Math.PI / 2, 0, 0]}
        args={[bed[0], bed[1]]}
        cellSize={10}
        cellThickness={0.6}
        cellColor={colors.cell}
        sectionSize={50}
        sectionThickness={1}
        sectionColor={colors.section}
        fadeDistance={1000}
      />

      {/* Build volume: a faint outline, so the height limit shows too. */}
      <lineSegments position={[0, 0, bed[2] / 2]} renderOrder={-1}>
        <edgesGeometry args={[volume]} />
        <lineBasicMaterial color={colors.section} transparent opacity={0.35} depthWrite={false} />
      </lineSegments>

      {nodes.map((n) => (
        <NodeMesh key={n.id} node={n} selected={n.id === selectedId} />
      ))}

      <Gizmo />
      <OrbitControls ref={orbit} makeDefault target={[0, 0, 10]} />
      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport labelColor="white" axisHeadScale={0.9} />
      </GizmoHelper>
      <CaptureBridge />
    </Canvas>
  );
}
