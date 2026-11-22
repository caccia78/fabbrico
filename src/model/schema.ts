// Scene model: the single source of truth.
// Everything the user (or the AI) does is an edit to this JSON tree, so it is
// always inspectable, undoable and re-editable with parameters.
//
// Units: millimetres. Axes: Z up, print bed is the XY plane at z = 0.
// Primitives are built sitting on the bed (z >= 0) and centred on the Z axis.

import { z } from 'zod/v4';

const num = z.number();
export const Vec3 = z.tuple([num, num, num]);
export const Vec2 = z.tuple([num, num]);
export type Vec3 = z.infer<typeof Vec3>;

export const Transform = z.object({
  position: Vec3.describe('Translation in mm [x, y, z]'),
  rotation: Vec3.describe('Rotation in degrees, applied X then Y then Z'),
  scale: Vec3.describe('Scale factors [x, y, z]'),
});
export type Transform = z.infer<typeof Transform>;

// ---------------------------------------------------------------- shapes ----

export const BoxShape = z.object({
  kind: z.literal('box'),
  size: Vec3.describe('Width, depth, height in mm'),
});
export const CylinderShape = z.object({
  kind: z.literal('cylinder'),
  radius: num.describe('Bottom radius (mm)'),
  radiusTop: num.describe('Top radius (mm). 0 makes a cone'),
  height: num,
  segments: num.describe('Circular segments, 0 = automatic'),
});
export const SphereShape = z.object({
  kind: z.literal('sphere'),
  radius: num,
  segments: num.describe('0 = automatic'),
});
export const TorusShape = z.object({
  kind: z.literal('torus'),
  majorRadius: num,
  minorRadius: num,
  segments: num.describe('0 = automatic'),
});
export const PolygonShape = z.object({
  kind: z.literal('polygon'),
  points: z.array(Vec2).describe('2D outline [[x,y],...] in the XY plane, counter-clockwise'),
  height: num.describe('Extrusion height along Z (mm)'),
  twist: num.describe('Twist of the top face in degrees'),
  scaleTop: num.describe('Scale of the top face (1 = straight, 0 = pyramid)'),
});
export const RevolveShape = z.object({
  kind: z.literal('revolve'),
  profile: z.array(Vec2).describe('Profile [[r, z], ...] with r >= 0, revolved around Z'),
  degrees: num,
  segments: num.describe('0 = automatic'),
});
export const SdfShape = z.object({
  kind: z.literal('sdf'),
  expression: z
    .string()
    .describe(
      'math.js expression of x, y, z (mm) returning a signed distance, POSITIVE INSIDE. ' +
        'Helpers: sphere(x,y,z,r), box(x,y,z,sx,sy,sz) (full sizes), cylinder(x,y,z,r,h), torus(x,y,z,R,r), ' +
        'capsule(x,y,z,ax,ay,az,bx,by,bz,r), sdfUnion(a,b), sdfSubtract(a,b), sdfIntersect(a,b), ' +
        'smoothUnion(a,b,k), smoothSubtract(a,b,k), smoothIntersect(a,b,k), noise(x,y,z), cells(x,y,z). ' +
        'Translate a primitive by offsetting coordinates, e.g. sphere(x-10, y, z-5, 4).',
    ),
  boundsMin: Vec3,
  boundsMax: Vec3,
  resolution: num.describe('Approximate triangle edge length (mm). Smaller = finer and slower; 0.5..2'),
});

export const FontNames = ['sans', 'sans-bold', 'serif', 'mono'] as const;
export type FontName = (typeof FontNames)[number];
export const TextAligns = ['center', 'left', 'right'] as const;

export const TextShape = z.object({
  kind: z.literal('text'),
  text: z.string().describe('The text; "\\n" starts a new line'),
  font: z.enum(FontNames),
  size: num.describe('Height of capital letters (mm). For FDM keep >= 5 mm (strokes >= 2 × nozzle); bold reads better'),
  height: num.describe('Extrusion height along Z (mm)'),
  align: z.enum(TextAligns).describe('Alignment of multiple lines'),
});

export const SketchShape = z.object({
  kind: z.literal('sketch'),
  contours: z.array(z.array(Vec2)).describe('Traced outlines in mm (even-odd: outer outlines and holes). When updating, pass [] to keep them'),
  height: num.describe('Extrusion height along Z (mm)'),
  penOffset: num.describe('How far outside the object edge the pen ran (mm); the outline is pulled in by this much. ~0.8 for an Apple Pencil'),
  strokeRadius: num.describe('Internal: half the width the tracing was rasterised with'),
});

export const MeshShape = z.object({
  kind: z.literal('mesh'),
  asset: z.string().describe('Id of an imported mesh (only the user can import meshes)'),
  triangles: num.describe('Triangle count, for information'),
});

export const ImageModes = ['relief', 'lithophane', 'logo'] as const;

export const ImageShape = z.object({
  kind: z.literal('image'),
  image: z
    .string()
    .describe('Grayscale image as a data URL. The user loads it in the inspector; when updating, pass "" to keep the current image'),
  mode: z
    .enum(ImageModes)
    .describe('"relief": bright = high; "lithophane": dark = thick (print upright, light shines through); "logo": the dark part extruded'),
  width: num.describe('Width in mm (height follows the image aspect ratio)'),
  thickness: num.describe('Base plate thickness under the relief (mm); for lithophanes the thinnest part, ~0.8'),
  depth: num.describe('Relief height above the base (mm); lithophane ~2.2; logo: extrusion height'),
  threshold: num.describe('Logo only: 0..1 brightness cut-off'),
  invert: z.boolean().describe('Swap dark and bright'),
  resolution: num.describe('Sample spacing (mm), 0.2..1'),
});

export type ShapeKind = 'box' | 'cylinder' | 'sphere' | 'torus' | 'polygon' | 'revolve' | 'sdf' | 'text' | 'image' | 'mesh' | 'sketch' | 'group';

// ------------------------------------------------------------- modifiers ----

export const DisplacePatterns = [
  'noise',
  'waves',
  'ribs',
  'knurl',
  'bumps',
  'cells',
  'expression',
] as const;

export const DisplaceFaces = ['all', 'top', 'bottom', 'sides', 'picked'] as const;

/**
 * A face region of an object: the surface patch around `point` (local frame)
 * whose normal is near `normal`, grown across edges sharper less than `angle`
 * degrees. A box face, the whole side of a cylinder, the dome of a sphere…
 */
export const FaceRegion = z.object({
  point: Vec3.describe('A point on the face, in the object local frame (mm)'),
  normal: Vec3.describe('The face normal at that point (local frame)'),
  angle: num.describe('Edges sharper than this (degrees) bound the region; 30 is a good default'),
});
export type FaceRegion = z.infer<typeof FaceRegion>;

export const ChamferEdges = ['both', 'top', 'bottom', 'all'] as const;
export const TeardropTips = ['pointed', 'flat'] as const;

export const Modifier = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('twist'),
    degrees: num.describe('Twist around the Z axis from bottom to top'),
  }),
  z.object({
    type: z.literal('taper'),
    scaleTop: num.describe('XY scale at the top, linearly interpolated from 1 at the bottom'),
  }),
  z.object({
    type: z.literal('bend'),
    degrees: num.describe('Bend along X, curling the ends upwards (negative = downwards)'),
  }),
  z.object({
    type: z.literal('round'),
    radius: num.describe('Fillet radius (mm) for convex edges; keeps outer size. Precise but slow on complex shapes'),
  }),
  z.object({
    type: z.literal('chamfer'),
    size: num.describe('45° bevel width/height on convex edges (mm); keeps outer size. Concave edges stay sharp'),
    edges: z
      .enum(ChamferEdges)
      .describe(
        'Which edges: "top" / "bottom" (horizontal edges facing up / down), "both", or "all" (also vertical edges). ' +
          'Boxes and axis-aligned polygons keep sharp vertical edges unless "all"; on other shapes vertical edges get rounded by the same size',
      ),
  }),
  z.object({
    type: z.literal('teardrop'),
    angle: num.describe('Steepest overhang allowed, degrees from vertical (45 for most printers)'),
    tip: z
      .enum(TeardropTips)
      .describe('"pointed" = classic teardrop; "flat" = cut at the top of the original shape (shorter, bridges a small gap)'),
  }),
  z.object({
    type: z.literal('smooth'),
    sharpAngle: num.describe('Edges sharper than this angle (deg) stay sharp; 0..180. Lower = keep more edges'),
    smoothness: num.describe('0..1, how round the smoothed edges get'),
    resolution: num.describe('Target edge length after refinement (mm)'),
  }),
  z.object({
    type: z.literal('displace'),
    pattern: z.enum(DisplacePatterns),
    amplitude: num.describe('Displacement depth in mm (positive = outwards)'),
    period: num.describe('Feature size / wavelength in mm'),
    faces: z
      .enum(DisplaceFaces)
      .describe('Which faces receive the texture: by normal direction, or "picked" = only the face region given by "region"'),
    region: FaceRegion.optional().describe('Required when faces is "picked"'),
    expression: z
      .string()
      .describe('Only for pattern "expression": math.js of x,y,z,nx,ny,nz returning -1..1'),
    resolution: num.describe('Edge length the surface is refined to before displacing (mm)'),
  }),
  z.object({
    type: z.literal('warp'),
    x: z.string().describe('New x as math.js expression of x,y,z (and bounds xmin,xmax,ymin,ymax,zmin,zmax)'),
    y: z.string(),
    z: z.string(),
    resolution: num.describe('Refine to this edge length first (mm), 0 = no refinement'),
  }),
]);
export type Modifier = z.infer<typeof Modifier>;
export type ModifierType = Modifier['type'];

// ----------------------------------------------------------------- nodes ----

export const LeafShape = z.discriminatedUnion('kind', [
  BoxShape,
  CylinderShape,
  SphereShape,
  TorusShape,
  PolygonShape,
  RevolveShape,
  SdfShape,
  TextShape,
  ImageShape,
  MeshShape,
  SketchShape,
]);
export type LeafShape = z.infer<typeof LeafShape>;

export interface GroupShape {
  kind: 'group';
  op: 'union' | 'intersection';
  children: SceneNode[];
}
export type Shape = LeafShape | GroupShape;

export interface SceneNode {
  id: string;
  name: string;
  color: string;
  /** A hole is subtracted from its siblings when grouped (Tinkercad style). */
  hole: boolean;
  transform: Transform;
  shape: Shape;
  modifiers: Modifier[];
}

// ------------------------------------------------------------- defaults ----

export const identity = (): Transform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

export function defaultShape(kind: Exclude<ShapeKind, 'group'>): LeafShape {
  switch (kind) {
    case 'box':
      return { kind, size: [20, 20, 20] };
    case 'cylinder':
      return { kind, radius: 10, radiusTop: 10, height: 20, segments: 0 };
    case 'sphere':
      return { kind, radius: 10, segments: 0 };
    case 'torus':
      return { kind, majorRadius: 12, minorRadius: 4, segments: 0 };
    case 'polygon':
      return { kind, points: [[-10, -8], [10, -8], [0, 10]], height: 5, twist: 0, scaleTop: 1 };
    case 'revolve':
      return { kind, profile: [[0, 0], [12, 0], [8, 10], [10, 25], [0, 25]], degrees: 360, segments: 0 };
    case 'text':
      return { kind, text: 'Fabbrico', font: 'sans-bold', size: 10, height: 2, align: 'center' };
    case 'mesh':
      return { kind, asset: '', triangles: 0 };
    case 'sketch':
      return { kind, contours: [], height: 10, penOffset: 0.8, strokeRadius: 0.75 };
    case 'image':
      return { kind, image: '', mode: 'relief', width: 80, thickness: 1, depth: 2, threshold: 0.5, invert: false, resolution: 0.4 };
    case 'sdf':
      return {
        kind,
        expression: 'smoothUnion(sphere(x, y, z - 10, 9), sphere(x - 9, y, z - 16, 6), 4)',
        boundsMin: [-12, -12, 0],
        boundsMax: [18, 12, 25],
        resolution: 1,
      };
  }
}

export function defaultModifier(type: ModifierType): Modifier {
  switch (type) {
    case 'twist':
      return { type, degrees: 45 };
    case 'taper':
      return { type, scaleTop: 0.6 };
    case 'bend':
      return { type, degrees: 45 };
    case 'round':
      return { type, radius: 2 };
    case 'chamfer':
      return { type, size: 1, edges: 'both' };
    case 'teardrop':
      return { type, angle: 45, tip: 'pointed' };
    case 'smooth':
      return { type, sharpAngle: 100, smoothness: 0.5, resolution: 1.5 };
    case 'displace':
      return { type, pattern: 'knurl', amplitude: 0.6, period: 3, faces: 'sides', expression: '', resolution: 0.6 };
    case 'warp':
      return { type, x: 'x', y: 'y', z: 'z + 2*sin(x/5)', resolution: 1 };
  }
}

export const PALETTE = ['#4f8cff', '#ff9f43', '#2ed47a', '#c56cf0', '#ff6b81', '#f6c945', '#38d9e8'];

/**
 * Cache key of a node's local geometry (shape + modifiers). A teardrop depends on
 * which way is up in the world, so then rotation and scale are part of it too.
 */
export function localGeometryKey(node: SceneNode): string {
  const worldDependent = node.modifiers.some((m) => m.type === 'teardrop');
  return JSON.stringify(
    worldDependent
      ? [node.shape, node.modifiers, node.transform.rotation, node.transform.scale]
      : [node.shape, node.modifiers],
  );
}

/** Ids of the imported meshes used by these nodes (and their children). */
export function meshAssetsOf(nodes: SceneNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.shape.kind === 'mesh' && n.shape.asset) out.add(n.shape.asset);
    if (n.shape.kind === 'group') meshAssetsOf(n.shape.children, out);
  }
  return out;
}

// ------------------------------------------------------------ validation ----

/** Full recursive node schema, used to validate project files on load. */
export const SceneNodeSchema: z.ZodType<SceneNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    name: z.string(),
    color: z.string(),
    hole: z.boolean(),
    transform: Transform,
    shape: z.union([
      LeafShape,
      z.object({
        kind: z.literal('group'),
        op: z.enum(['union', 'intersection']),
        children: z.array(SceneNodeSchema),
      }),
    ]),
    modifiers: z.array(Modifier),
  }),
);
