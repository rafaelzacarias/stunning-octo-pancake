I want you to build an ultra-realistic, AAA-quality 3D Metal Shredding Simulator in Three.js, matching the physical realism and visual fidelity of Teardown, BeamNG.drive, and Hardspace: Shipbreaker.

The application must run smoothly in WebGL (targeting 60 FPS) and feature hyper-satisfying, photorealistic metal destruction.

### Architectural Sub-Agent Breakdown
Fan out dedicated sub-agents to build, critique, and refine each subsystem in parallel:

#### Agent 1: Engine & Physical Destruction (Physics Sub-Agent)
* Implementation: Integrate Rapier3D or PhysX (via WebAssembly) offloaded to a Web Worker to prevent UI thread stutter.
* Shredder Mechanics: Model dual counter-rotating shafts with interleaved, hardened steel teeth.
* Metal Deformation & Tearing: Implement dynamic mesh splitting/slicing algorithms. Metal items fed into the shredder must bend, yield, and shear into distinct fragments based on kinetic force and material thickness.
* Object Feeder: Interactive conveyor belt or drop zone with selectable objects (aluminum cans, steel beams, car engine blocks, metal pipes).

#### Agent 2: Materials & Photorealistic Shaders (Graphics Sub-Agent)
* Materials: Custom PBR shaders (MeshPhysicalMaterial) featuring anisotropy, scratch maps, rust textures, normal map displacement, and metallic roughness maps.
* Shear Heat Effect: Custom GLSL vertex/fragment shader modifier that adds an glowing red/orange heat gradient along the tear edges of shredded metal as teeth cut through.
* Lighting & Post-Processing: HDRI studio lighting, Screen-Space Ambient Occlusion (SSAO), Screen-Space Reflections (SSR), and selective Bloom for hot glowing metal and sparks.

#### Agent 3: VFX & Audio Feedback (Juice Sub-Agent)
* Particle Systems: GPU-instanced particle emitters generating high-velocity directional metal sparks (with physics bounce and gravity), metallic dust, and flying tiny shrapnel bits.
* Procedural Audio: Layered Web Audio API system featuring dynamic motor hum, high-pitch metal scraping, heavy crunching SFX, and pitch-bending motor strain when crushing thick metal.

#### Agent 4: Interaction & Camera Controls (UX Sub-Agent)
* Camera: Smooth OrbitControls with dynamic cinematic depth of field (DoF) and contextual screen-shake tied to crushing load.
* Controls: Shredder power toggle, reverse gear, conveyor speed slider, camera presets (Top-down, Teeth-Eye Close-up, Wide Factory view).

---

### The Harsh Visual Critic Loop (/loop)
Spawn a dedicated **Visual QA Critic Sub-Agent**. 

After each iteration:
1. Render a frame of the shredding process (lighting, tooth contact, spark generation, fragment mesh tearing).
2. Evaluate the output against visual standards from Teardown, BeamNG.drive, and Hardspace: Shipbreaker.
3. Check specifically for:
   - Are the metal sparks reacting naturally to collisions?
   - Does the metal show plastic deformation/bending before splitting?
   - Is the metallic specular highlighting realistic under the HDRI map?
   - Is performance locked above 60 FPS without dropping frames?
4. If any detail feels floaty, low-poly, or visually lacking, reject the build, log the exact flaws, and loop back to the responsible sub-agent for fix iterations.

Do not stop until the simulation provides a seamlessly smooth, visually stunning, photorealistic ASMR metal shredding experience.
