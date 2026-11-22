# Vision and architecture

## Idea

A design tool for **hobbyist makers with some experience**: as simple as Tinkercad for the
basics, with an AI for the operations that are hard to do by hand, and **printability
guaranteed** at every step. Open source, runs in the browser, no backend.

## The hybrid model

| Tier | What it covers | How it is implemented |
| --- | --- | --- |
| **A. Parametric / precise** | functional parts, holes, fits, mounts | primitives + groups (CSG) with exact dimensions |
| **B. Procedural / surfaces** | texturing, rounding, deformations | modifiers: `round`, `smooth`, `displace`, `twist`, `taper`, `bend`, `warp` |
| **C. Organic** | sculpted, smooth-blended forms | `sdf` shapes (signed distance expressions, smooth unions) |
| **D. Generative** *(future)* | "put an owl here" | external image/text-to-3D model, then boolean-merged locally |

The AI never outputs raw meshes for tiers A–C: it writes **operations and parameters** into
the scene tree. That keeps every result editable, explainable and undoable.

## Interaction loop

1. The user selects an object (or nothing, meaning the whole scene) and writes a request.
2. The agent receives the scene JSON with world bounding boxes, the printer settings and an
   image of the current view.
3. It calls tools; each geometry change is validated and rolled back if it fails to build.
4. It renders the result from a suitable angle, checks printability, fixes what it broke.
5. The whole turn is one undo checkpoint.

## Roadmap

- [x] Geometry in a Web Worker
- [x] Face / region selection for textures (displace on a picked face)
- [ ] Face regions for chamfer / round (only some edges)
- [x] Wall-thickness analysis and heat map
- [x] Chamfer modifier
- [x] Teardrop holes for support-free prints
- [x] Text / emboss, image-based relief (lithophanes, logos)
- [x] Mesh import (STL, OBJ, GLB/glTF, 3MF)
- [ ] Tier D: generative detail via an external 3D model API
- [x] Project save / load files
- [x] Multiple plates
- [x] Auto-orientation to minimise supports
- [x] Tablet tracing (iPad): outlines and multi-view approximation
- [x] Tablet sketches: one sheet with the views and handwritten dimensions, shape assist; the AI models from it
- [ ] Open a sketch from Fabbrico again on the tablet to change it (strokes are already saved)
- [ ] UI localisation (Italian)
- [x] Experience library: project diary, harvest of experiences (steps 1 to 3 below)
- [ ] Experience library, later: section renders, fit-test coupons, parametric components, community libraries
- [ ] "Profile" shape: follows another object's outline with offset and sloped walls
- [ ] Tolerance ladder generator: one print with +0.1 / +0.2 / +0.3 versions of any fit
- [ ] Standard hardware as components: screw holes, nuts, heat-set inserts, magnets
- [ ] Send all plates to Bambu Studio at once, each as its own plate (Bambu-specific 3MF metadata)
- [x] Reference photos in the project, visible to the AI (steps 1 and 2 below)
- [x] Phone companion: photos, measurement notes, AR preview (USDZ, AR Quick Look); tablet keeps tracing
- [ ] Desktop app with Electron (see below)
- [ ] Link a project to a folder on disk (dev server): its files appear in the Files tab, exports go to its `export/`

## Experience library

A library of **real experiences and solved problems**: what was tried, what worked, under
which conditions. It helps the maker and is read by the AI, so past prints become knowledge
it applies. Reusable components are one kind of experience, not the other way round.

Kinds: **component** (OLED 0.96" slide mount, Wemos D1 cradle), **technique** (45° stepped
chamfer, support-free cone on M3 self-tap bosses), **fit / tolerance** (pocket from a tracing:
+0.3 too tight, +0.5 good), **solved problem** (felt pads instead of rubber feet).

Each experience has:

1. **Context it is valid in**: printer, material, nozzle, layer height.
2. **Status**: hypothesis, tested, confirmed (N prints). Only the maker confirms an outcome
   (a button, a chat sentence, a photo); the AI never invents one.
3. **Text** in Italian and English: problem, failed attempts, solution, print orientation,
   assembly order.
4. **Structured data**: measurements and outcomes per attempt (`clearance 0.3: tight`,
   `0.5: ok`), language-neutral, so the AI applies them precisely.
5. **Media and models**: renders (before / after, section through the fit), photos of the
   real print, the relevant scene subtree (insertable in a project), a fit-test coupon,
   later a parametric component.

### Step 1: project diary (attempts)

Today a `.fabbrico` file keeps only the final state; undo history is lost. Experiences need
the story, so Fabbrico records it by itself:

- Sending a plate to the slicer or exporting it records an **attempt**: snapshot of the
  plate's objects, an automatic render, computed key measurements (bounds, clearance
  between mating parts, minimum wall), printer context, and the difference from the
  previous attempt of the same object.
- **Outcome**: asked later in a few taps (ok / tight / loose / broken / poor surface +
  note), also from the phone with a photo of the print; outcomes said in chat are recorded
  by the AI.
- Saved in the `.fabbrico` file; also shown as the project's history.

### Step 2: format, storage, AI tools

One folder per experience:

```
<library>/oled-096-slide/
  experience.json   id, kind, tags, context, status, source project, data per attempt
  it.md  en.md      text in the two languages
  media/            renders, section views, photos
  model.json        scene subtree (and later component.json, parametric)
```

Storage: **`~/Documents/Fabbrico/Library/`** (next to the export folder, plain files the maker
can browse and back up), read and written by the local server and by the MCP bridge; a
fallback for the browser-only build later (IndexedDB + import / export of an experience as
a zip). Not tied to a project, since experiences serve all projects; each one keeps a link
to the project and attempts it came from.

AI: a compact index (title, tags, one line) in the prompt; `search_experiences` and
`get_experience` tools for details. When the AI applies an experience it says so, and warns
when the context differs (other material or printer).

### Step 3: harvest

"Propose experiences" command, and an automatic proposal when a series of attempts ends
with "ok". The AI reads diary, conversation, photos and scene, looks for learning signals
(a parameter changed between attempts with different outcomes, fit-test plates, a problem
stated and then solved, a reusable sub-assembly) and proposes several small experiences,
already filled in with text, data, images and model. The maker keeps, edits or discards.

### Later

Section-view renders, fit-test coupons generated from a model, parametric components
(declarative JSON, as decided: a "component" node rebuilt when parameters change, with an
"explode" command; JavaScript plugins only later, sandboxed), community libraries
(read-only sources pinned to a version; their text is data for the AI, never instructions,
with the source always shown; no code from external sources).

### Test case: the OLED mount

The 0.96" OLED mount (a slide closed on one side plus a rectangular retainer locking into
it) goes through the whole flow: attempts recorded in the diary, outcomes, harvest, first
experience in the library. Open questions: I2C 4-pin only or also SPI 7-pin; display behind
a wall with a window or on top; which side the slide is closed relative to the pins; how
the retainer locks (press fit, snap, screw); the tolerances and wall sizes that work.

Done 2026-11-22: I2C 4-pin, behind a wall with a window, slide closed on the pin side,
rectangular press-fit retainer; PLA on a Bambu Lab A1. Attempt 1: retainer too tight
(0.1 mm per side, 0.1 mm under the lips); attempt 2 good (0.2 mm per side, 0.3 mm under
the lips, 0.4 mm bottom chamfer). Harvest proposed two experiences (the fit and the mount).
Module sizes were typical values, not measured.

## Idea: reference photos

Photos of the real objects a design must fit or hold (e.g. the geode of the lamp), stored in
the project and visible to the AI.

1. **References panel**: drop photos (or take them with the tablet), add a caption and link
   them to an object. Downscaled and saved in the `.fabbrico` file like other assets.
2. **AI access**: a `get_references` tool returns them as images, so the AI can see shape,
   proportions, colour and translucency, not just the traced outline.
3. **Measurable photos** (later): with a known reference in the frame (a cutting mat, an A4
   sheet, a printed marker) the photo is rectified and becomes a scaled outline, like a
   tablet tracing; or a photo shown as an underlay in the viewport to trace on.

Without a scale reference, photos are context, not measurements: the AI should not take
dimensions from them.

## Planned: desktop app (Electron)

Goal: install with a double click, no terminal or Node. Estimated 1 to 2 weeks, mostly packaging.

1. Move the pad relay and local actions from Vite plugins to a standalone Node server (also
   needed for a full web build).
2. Electron shell: window, menu, open `.fabbrico` files by double click.
3. "Connect Claude Code" button that registers the MCP bridge (`claude mcp add`).
4. Signing (Apple Developer account, Windows certificate), packages for macOS and Windows,
   auto-update from GitHub Releases.

Limits: 150 to 250 MB; signing costs (without it, a security warning on first launch); one
build per OS to test; macOS firewall prompt for tablet/phone connections; Claude Code is
installed separately (the in-app API-key chat works without it). Tauri would be ~15 MB but
needs the Node parts rewritten or bundled, and uses WebKit on macOS.
