/**
 * Shared machine layout. Physics, rendering, camera framing, VFX emitters and
 * audio positioning all derive from these numbers so nothing can drift apart.
 * Units: metres, kilograms, seconds.
 */
export const LAYOUT = {
  // --- shredder ---
  shaftY: 1.10,             // height of both shaft centre-lines
  shaftSeparation: 0.255,   // centre-to-centre distance across Z
  cutterRadius: 0.172,      // tip radius of the hook teeth
  hubRadius: 0.108,
  cutterThickness: 0.052,   // width of a single disc along X
  cutterPitch: 0.104,       // spacing of discs along the shaft
  cuttersPerShaft: 12,
  teethPerCutter: 5,
  throatWidth: 1.248,       // cuttersPerShaft * cutterPitch

  // --- machine body ---
  // The hopper outlet deliberately sits BELOW the cutter tip height (1.272 m)
  // and is wider than the largest feed stock, so material lands directly on
  // the teeth instead of bridging across a narrow slot.
  housing: { hx: 0.92, hz: 0.88, yMin: 0.0, yMax: 1.34 },
  hopper: { topY: 2.00, bottomY: 1.16, topHX: 0.86, topHZ: 0.95, bottomHX: 0.64, bottomHZ: 0.315 },
  chute: { topY: 0.92, bottomY: 0.30, hx: 0.72, hz: 0.5 },
  bin: { center: [0, 0.0, -1.75], hx: 0.9, hy: 0.42, hz: 0.62 },

  // --- conveyor ---
  conveyor: {
    y: 2.15,
    halfWidth: 0.62,
    startZ: 4.5,
    endZ: 0.72,
    beltThickness: 0.035,
    maxSpeed: 2.2,
  },

  // --- room ---
  room: { hx: 14, hz: 16, height: 8.4 },
  floorY: 0,

  // camera framing anchors
  throatCenter: [0, 1.24, 0],
};

export const SETTINGS = {
  maxFragments: 120,
  maxSlicesPerFrame: 3,
  minFragmentVolume: 2.4e-5,   // m^3 — below this it becomes shrapnel/particles
  fragmentLifetime: 26,        // seconds before quiet cleanup
  maxScrapBodies: 110,
  sparkCapacity: 16384,
  dustCapacity: 4096,
  // Fragments with a bounding radius under this stop casting shadows: they
  // are visually irrelevant but each one costs a full shadow-map draw.
  shadowCasterMinRadius: 0.055,
};
