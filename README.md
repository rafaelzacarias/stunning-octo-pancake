# SHRED.IO — Industrial Metal Shredder Simulator

A real-time, photoreal dual-shaft metal shredder built on Three.js and Rapier3D.
Everything is generated procedurally in code — there are no external textures,
HDR maps, models or audio files, and no network requests at runtime.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
```

Requires WebGL 2. Click **CLICK TO INITIALIZE** to start (the Web Audio context
needs a user gesture). The original brief is preserved in [BRIEF.md](BRIEF.md).

---

## Controls

| Input | Action |
|---|---|
| `Space` | Main power on/off |
| `R` | Reverse rotors |
| `C` | Clear all debris |
| `1`–`9` | Drop feed stock onto the conveyor |
| `F1`–`F5` | Camera presets (Wide / Teeth-Eye / Top-Down / Discharge / Operator) |
| `Tab` | Hide the interface |
| Left-drag | Orbit · Scroll: dolly · Right-drag: pan |
| Click over the hopper or belt | Drop the selected item at that point |

---

## Architecture

```
src/
├── main.js                       frame loop, wiring, adaptive quality guard
├── config.js                     single source of truth for machine layout
├── core/
│   ├── Engine.js                 renderer, camera, frame timing
│   └── PostFX.js                 GTAO → bloom → bokeh → output → SMAA → grade
├── physics/
│   ├── physics.worker.js         Rapier world, runs entirely off the UI thread
│   └── PhysicsBridge.js          transform/contact channel, zero-copy buffers
├── shredder/Shredder.js          rotor generation, hopper, conveyor, colliders
├── destruction/
│   ├── MeshSlicer.js             plane splitting with torn-edge caps
│   ├── Deformer.js               plastic dent / bend / crush
│   └── FragmentManager.js        damage model, slice scheduling, budgets
├── materials/
│   ├── ProceduralTextures.js     fBm-based PBR map generator
│   ├── MetalMaterial.js          material library + mechanical constants
│   └── HeatShader.js             shear-heat incandescence injection
├── vfx/
│   ├── GPUParticles.js           MRT ping-pong particle simulation
│   └── VFXDirector.js            spark/dust/shrapnel choreography
├── env/FactoryEnvironment.js     procedural HDRI probe + factory + lighting
├── camera/CameraDirector.js      orbit, preset moves, trauma shake, autofocus
├── audio/AudioEngine.js          fully synthesised industrial audio
├── objects/ScrapLibrary.js       feed stock geometry + collider descriptions
├── utils/GeometryBatcher.js      static-prop draw-call batching
└── ui/                           control room HUD
```

### Physics — off-thread Rapier

The Rapier world lives in a Web Worker with its own fixed 60 Hz accumulator, so
a slow render frame never stalls the simulation and slicing spikes never stutter
the UI. Transforms come back as transferable `Float32Array`s that ping-pong
between the threads, so the hot path allocates nothing.

Each cutter disc is its own kinematic-position body, driven by
`setNextKinematicRotation`, which gives Rapier the correct surface velocity as
the teeth sweep through material.

### Rotor geometry

The tooth profile is generated once and used for **both** the render mesh and
the collision hulls, so what you see biting the metal is exactly what the solver
uses. Three details make it behave like a real machine rather than a gear:

- The two shafts run on a **1 : 1.28 differential** so teeth wipe past each
  other and self-clean instead of jamming.
- Shaft discs are offset by a **quarter pitch in opposite directions** so each
  shaft's discs sit in the other's gaps — without this there is a straight
  vertical path between aligned discs and thin stock falls through uncut.
- Physics hubs span a **full pitch** so adjacent hubs abut into a continuous
  roll, closing the 52 mm axial slot between discs.

### Destruction

Damage is normalised cut progress (0 → 1) that accrues mainly from **engagement
time**, scaled by section thickness and material shear strength.

This is deliberate. A force-based criterion cannot work across a 4000:1 mass
range: a 16 g drinks can physically cannot press hard enough against a tooth to
accumulate kilonewton-seconds, so it would rattle around forever, while a 62 kg
engine block would shear instantly under its own weight. What actually decides
the outcome in a shredder is how long a tooth stays buried in the stock.

The pipeline per piece is **yield → bend → shear**:

1. Past 18 % progress the section is worked — `plasticDent` presses a crater
   with a raised rim and crumple noise, `plasticBend` folds long ductile stock.
   Normals are re-derived from the displacement gradient rather than by
   `computeVertexNormals()`, so machined edges stay sharp.
2. At 100 % the piece is sheared by `MeshSlicer`, which does full attribute
   interpolation, ear-clipped caps with hole support (hollow pipes cut
   correctly), and applies a deterministic out-of-plane displacement **at the
   intersection point** so the cap and the side-wall boundary stay welded and
   the two halves still interlock.
3. Cut planes prefer the disc shear faces (producing real shredder ribbons);
   once a piece is narrower than a strip it is chopped across its longest axis.
4. Offcuts below ~24 cm³, or more than four generations deep, become GPU
   shrapnel and dust instead of yet another rigid body.

Fresh cut vertices are stamped white-hot; the shader reconstructs a two-term
cooling curve analytically, so glowing tear edges cost zero CPU per frame no
matter how many fragments exist.

Measured yield-before-shear, dropping one item into a running throat:

| Stock | Bend before cut | Peak deflection |
|---|---|---|
| Steel panel (1.2 mm galvanised) | yes | 96 mm |
| I-beam offcut (900 mm mild steel) | yes | 177 mm |
| Aluminium can | yes | 28 mm |
| Tool box (painted steel) | yes | 27 mm |
| Copper radiator | yes | 4 mm |
| Cast gear (brittle grey iron) | yes | 2 mm — snaps, as cast iron should |

### Rendering

- **Procedural HDRI**: an emissive room is rendered to a cube map and PMREM
  pre-filtered. Long thin high-bay strips give metal the elongated streak
  highlights that sell an anisotropic brushed finish.
- **Materials**: `MeshPhysicalMaterial` with KHR-style anisotropy, plus
  generated albedo / normal (Sobel from a real height field) / roughness /
  metalness / AO maps.
- **Selective bloom**: the threshold sits *above* lit-metal range (~1.2) so only
  sparks, tear-edge incandescence and lamp filaments glow. This matters more
  than it sounds — at a lower threshold bloom veils the whole frame and every
  surface reads as white.
- **Particles**: position+life and velocity+type live in two float render
  targets that ping-pong through a simulation shader with real gravity, drag and
  plane collision (floor, steel deck, conveyor belt, machine cheeks). Sparks,
  shrapnel, dust and embers all render in one instanced draw call using
  premultiplied alpha so additive and alpha-blended particles coexist.

Two non-obvious calibrations that the visual QA pass forced:

- Authored roughness/metalness maps are **absolute**, so `material.roughness`
  and `material.metalness` must stay at `1.0`. three multiplies map × scalar;
  anything lower drove scratch texels to ~0.02 roughness — mirror polish — and
  every surface broke out in white specular confetti.
- Practical light intensities are candela and must stay in scale with each
  other. A point light a few centimetres from the metal blows out
  catastrophically at values that look reasonable in the inspector.

### Performance

Measured with `gl.finish()` on an Apple M4 Pro at 1488×837, ultra quality, 37
fragments, 289 draw calls: **0.47 ms median GPU time per frame**. Under a full
overload (108 fragments, 381k triangles, 643 draw calls) the app holds
**125–140 FPS**.

Two things keep it there:

- `GeometryBatcher` merges the factory's hundreds of static props per material.
  Each one would otherwise be a draw call in the beauty pass *and* again in
  every shadow map — this alone took draw calls from ~550 to ~170.
- An adaptive guard sacrifices **resolution first** and only steps down a
  quality tier when resolution is exhausted, because losing SSAO/DoF/AA outright
  is far more visible than a few percent of pixels.

### Audio

Fully synthesised: detuned saw/square motor stack with a gear-whine layer and
120 Hz mains hum, cascaded band-pass noise for the scrape shriek, layered
inharmonic clang voices for impacts, granular bursts for tears, and a
procedurally generated concrete-hall impulse response on a reverb send. Motor
pitch bends down under load and overshoots on recovery like a real governor.

---

## Known behaviour

- The I-beam and engine block are meant to be hard. They visibly fold and bog
  the motor to ~19 RPM before letting go.
- Feeding continuously at 90 % belt speed will overload the throat and hit the
  body budget; that is the machine being overwhelmed, not a failure.
- SSR is available under *Simulation & Post* but is off by default: it renders
  its own beauty pass and is expensive for what the environment probe already
  provides.
