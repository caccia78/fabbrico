// Tool contracts (name, description, input schema) shared by the two ways
// Claude can drive Fabbrico:
//   - the in-app chat (Anthropic API with the user's key), see agent.ts
//   - Claude Code through the MCP bridge (user's Claude subscription), see bridge/
// This file must stay free of browser dependencies: the Node bridge imports it.

import { z } from 'zod/v4';
import { LeafShape, Modifier, Vec3 } from '../model/schema';

export const PartialTransform = z.object({
  position: Vec3.optional(),
  rotation: Vec3.optional(),
  scale: Vec3.optional(),
});

export const VIEWS = ['iso', 'top', 'front', 'right', 'back', 'left', 'bottom', 'current'] as const;

export const TOOL_SPECS = {
  get_scene: {
    description:
      'Get the current scene as JSON (objects with world bounding boxes), the object the user has selected, the printer settings, and an image of the view the user is looking at. Call this first for every new user request.',
    schema: z.object({}),
  },
  add_object: {
    description:
      'Add a new object (primitive, extruded polygon, revolved profile or SDF). Returns its id and world bounds.',
    schema: z.object({
      name: z.string(),
      shape: LeafShape,
      transform: PartialTransform.optional(),
      modifiers: z.array(Modifier).optional(),
      color: z.string().optional().describe('CSS hex colour'),
      hole: z.boolean().optional().describe('true = negative volume used to cut other objects when grouped'),
    }),
  },
  update_object: {
    description:
      'Change an existing object. Only given fields change. "shape" replaces the whole shape (not allowed on groups), "modifiers" replaces the whole modifier stack, "transform" fields are replaced individually.',
    schema: z.object({
      id: z.string(),
      name: z.string().optional(),
      color: z.string().optional(),
      hole: z.boolean().optional(),
      shape: LeafShape.optional(),
      transform: PartialTransform.optional(),
      modifiers: z.array(Modifier).optional(),
    }),
  },
  delete_objects: {
    description: 'Delete objects by id.',
    schema: z.object({ ids: z.array(z.string()) }),
  },
  group_objects: {
    description:
      'Combine root-level objects into one group. op "union": solids merge and children with hole=true are subtracted. op "intersection": keep only the common volume.',
    schema: z.object({
      ids: z.array(z.string()).min(2),
      op: z.enum(['union', 'intersection']),
      name: z.string().optional(),
    }),
  },
  duplicate_objects: {
    description:
      'Copy objects with fresh ids (groups are copied with all their children). Works on root objects and on objects inside a group: ' +
      'a nested object is copied as a root object, with its transform relative to its old parent group (identical in world space only if that group has no transform). ' +
      '"offset" moves the copies (mm). "to_plate" (a plate name) puts the copies on another plate without switching to it. Returns the new ids and world bounds. ' +
      'This is the way to reuse a tracing, image or imported mesh, which you cannot create yourself.',
    schema: z.object({
      ids: z.array(z.string()).min(1),
      offset: Vec3.optional(),
      to_plate: z.string().optional().describe('Name of the target plate; default the current plate'),
    }),
  },
  add_plate: {
    description:
      'Add a new empty build plate and make it the current one (all object tools act on the current plate). Use it for test prints or parts printed separately.',
    schema: z.object({ name: z.string().optional() }),
  },
  switch_plate: {
    description: 'Make another plate the current one, by name. The user sees the switch in Fabbrico.',
    schema: z.object({ name: z.string() }),
  },
  get_outline: {
    description:
      'Exact cross-section of an object at a world height z (default: its mid-height), as closed [x, y] contours in WORLD mm (through all parent groups): ' +
      'counter-clockwise outer outlines, clockwise holes. Use it to read the shape of tracings, imported meshes or any solid, ' +
      'e.g. to build walls, pockets, lids or gaskets that follow it. "offset" grows (+) or shrinks (-) the outline in mm with round corners, ' +
      '"tolerance" (default 0.1 mm) simplifies it. The contours can be passed straight to a polygon shape (translate it back if the object was moved).',
    schema: z.object({
      id: z.string(),
      z: z.number().optional(),
      offset: z.number().optional(),
      tolerance: z.number().min(0.01).max(2).optional(),
    }),
  },
  ungroup: {
    description: 'Split a root-level group back into its children.',
    schema: z.object({ id: z.string() }),
  },
  place_on_bed: {
    description: 'Move root objects vertically so their lowest point rests exactly on z = 0.',
    schema: z.object({ ids: z.array(z.string()) }),
  },
  orient_for_print: {
    description:
      'Rotate root objects to the orientation that needs the least support material (and rests on a good flat face), then place them on the bed. ' +
      'Returns the new rotation and support estimates before/after. Use when the user asks how to print something or to minimise supports; it changes the rotation, so mention it.',
    schema: z.object({ ids: z.array(z.string()).min(1) }),
  },
  render_view: {
    description:
      'Render the scene and return an image so you can check your work. Use "focus_id" to frame one object. ' +
      '"overlay" colours the model for analysis: "thickness" (red < nozzle, orange < 2× nozzle, yellow < 3× nozzle, green fine, blue thick) ' +
      'or "overhangs" (red/orange = needs support).',
    schema: z.object({
      view: z.enum(VIEWS),
      focus_id: z.string().optional(),
      overlay: z.enum(['none', 'thickness', 'overhangs']).optional(),
    }),
  },
  get_references: {
    description:
      'Look at the reference photos the user attached to the project (pictures of the real objects the design must fit, hold or look like). ' +
      'get_scene lists them under "references" (id, name, caption, linked object). Pass the ids to see (at most 6); omit ids for all of them if there are 6 or fewer. ' +
      'Photos have no scale: use them for shape, proportions, look and details, not for dimensions, unless an object of known size is visible next to it. ' +
      'Sketches (kind "sketch") are hand drawings of a part with dimensions written on them: the drawing is not to scale, the numbers are (mm unless a unit such as cm is written).',
    schema: z.object({ ids: z.array(z.string()).max(6).optional() }),
  },
  check_printability: {
    description:
      'Analyse the whole printable model: bed fit, below-bed, floating, separate parts, overhang percentage, wall thickness (thin walls with location), volume and PLA mass.',
    schema: z.object({}),
  },
  // ----- Project diary and experience library (experimental) -----
  get_diary: {
    description:
      'Read the project diary: every print of a plate is an attempt (number n, plate, printer/material, what changed since the previous attempt of that plate, sizes, outcome reported by the user, photos of the real print). ' +
      'Without "attempts" it returns all attempts as text. With "attempts" (numbers, at most 4) it also returns their renders and print photos.',
    schema: z.object({ attempts: z.array(z.number().int()).max(4).optional() }),
  },
  set_attempt_outcome: {
    description:
      'Write down the outcome of a print attempt that the USER reported in the conversation (e.g. "fits well", "too tight", "it broke"). ' +
      'Never guess or infer an outcome the user did not state. result: ok, tight, loose, broken, surface (poor surface), other. Put the user\'s words and any measurement in note.',
    schema: z.object({
      attempt: z.number().int().describe('Attempt number n from the diary'),
      result: z.enum(['ok', 'tight', 'loose', 'broken', 'surface', 'other']),
      note: z.string().optional(),
    }),
  },
  propose_experience: {
    description:
      'Propose one experience for the maker\'s library, from the diary and the conversation: one thing learnt (a fit/tolerance that worked, a technique, a reusable component, a solved problem). ' +
      'The user reviews it in Fabbrico (Diary tab) and keeps or discards it. Write title, summary (one sentence) and body in Italian and English; the body tells the problem, what was tried (failed attempts too), the solution, print orientation / assembly tips, and when it applies. ' +
      'Put key numbers in "values" (e.g. {"clearance_mm": 0.5, "wall_mm": 1.2}), list the attempt numbers it is based on and the ids of the objects worth keeping as its model. ' +
      'Status (hypothesis / tested / confirmed) is computed from the outcomes the user reported: don\'t claim more than they show. Propose several small experiences rather than one summary of the project.',
    schema: z.object({
      kind: z.enum(['component', 'technique', 'fit', 'problem']),
      title: z.object({ it: z.string(), en: z.string() }),
      summary: z.object({ it: z.string(), en: z.string() }),
      body: z.object({ it: z.string(), en: z.string() }).describe('Markdown'),
      tags: z.array(z.string()).describe('Lower-case keywords: hardware (oled-096, ssd1306, m3), technique (press-fit, snap-fit), material…'),
      values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      attempts: z.array(z.number().int()).describe('Attempt numbers it is based on'),
      object_ids: z.array(z.string()).optional().describe('Objects (ids, in the last of those attempts or in the scene) to keep as the model'),
    }),
  },
  search_experiences: {
    description: 'Search the maker\'s experience library (real prints with their outcomes) by words in titles, summaries and tags. Without query: list all.',
    schema: z.object({ query: z.string().optional() }),
  },
  get_experience: {
    description:
      'Read one experience of the library: text (Italian and English), key values, the attempts with outcomes, the context it was learnt in (printer, material) and up to 4 images. ' +
      'When you apply it, say so and warn if the current printer or material differ.',
    schema: z.object({ id: z.string() }),
  },
} as const;

export type ToolName = keyof typeof TOOL_SPECS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_SPECS)[N]['schema']>;

/** Neutral result format, converted to Anthropic API or MCP content by each side. */
export type ToolOutput = string | { image: string /* base64 jpeg */ } | Array<string | { image: string }>;

export function jsonSchemaOf(name: ToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(TOOL_SPECS[name].schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function parseInput<N extends ToolName>(name: N, input: unknown): ToolInput<N> {
  const parsed = TOOL_SPECS[name].schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`);
  return parsed.data as ToolInput<N>;
}

export const isToolName = (n: string): n is ToolName => n in TOOL_SPECS;
