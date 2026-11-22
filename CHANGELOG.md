# Changelog

## 0.1.0

First public release, an early prototype.

- Design by hand with primitives, extruded polygons, revolved profiles, text, images (relief,
  lithophane, logo), imported meshes (STL, OBJ, GLB/glTF, 3MF) and organic SDF shapes; holes and
  groups Tinkercad style; plates.
- Modifiers: fillet, chamfer, teardrop holes, smoothing, surface textures (noise, waves, ribs,
  knurl, bumps, cells, custom), twist, taper, bend, free-form warp.
- Watertight geometry with Manifold, built in a background worker.
- Printability: bed fit, floating parts, overhang and wall-thickness maps, orient for print.
- AI assistant with Claude: through Claude Code (your Claude subscription, via the MCP bridge) or
  in the app with an Anthropic API key. It edits the parametric scene, renders and checks its work.
- Tablet and phone: trace real objects with an Apple Pencil, hand-drawn sketches with dimensions,
  reference photos, measurement notes, AR preview.
- Project diary of print attempts and an experience library that the AI can reuse.
- Export 3MF / STL, or send the plate straight to Bambu Studio, OrcaSlicer or PrusaSlicer.
