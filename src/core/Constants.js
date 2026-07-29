/**
 * Shared, dependency-free constants.
 * Every subsystem imports from here so that physics, rendering, VFX and audio
 * all agree on units, scale and identifiers.
 *
 * UNITS: metres, kilograms, seconds. World is Y-up, right-handed.
 */

/* ------------------------------------------------------------------ *
 * Collision filtering (Rapier packs membership in the high 16 bits and
 * the filter mask in the low 16 bits of a single u32).
 * ------------------------------------------------------------------ */
export const GROUP = {
  WORLD: 1 << 0, // static factory shell, hoppers, floor
  TEETH: 1 << 1, // rotor discs + cutting teeth
  SCRAP: 1 << 2, // intact feed stock
  FRAGMENT: 1 << 3, // post-cut pieces
  DEBRIS: 1 << 4 // tiny shrapnel, non-interactive with each other
};

/** Build a Rapier collision-group u32 from membership + filter sets. */
export function collisionGroups(membership, filter) {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const FILTER = {
  WORLD: collisionGroups(GROUP.WORLD, GROUP.SCRAP | GROUP.FRAGMENT | GROUP.DEBRIS | GROUP.TEETH),
  TEETH: collisionGroups(GROUP.TEETH, GROUP.SCRAP | GROUP.FRAGMENT | GROUP.WORLD | GROUP.DEBRIS),
  SCRAP: collisionGroups(GROUP.SCRAP, GROUP.WORLD | GROUP.TEETH | GROUP.SCRAP | GROUP.FRAGMENT),
  FRAGMENT: collisionGroups(GROUP.FRAGMENT, GROUP.WORLD | GROUP.TEETH | GROUP.SCRAP | GROUP.FRAGMENT),
  DEBRIS: collisionGroups(GROUP.DEBRIS, GROUP.WORLD | GROUP.TEETH)
};

/* ------------------------------------------------------------------ *
 * Render layers. Layer 1 is the selective-bloom layer: anything on it is
 * additively bloomed (hot shear edges, sparks, warning lamps).
 * ------------------------------------------------------------------ */
export const LAYER = {
  DEFAULT: 0,
  BLOOM: 1,
  NO_SSR: 2
};

/* ------------------------------------------------------------------ *
 * Material library. Values are physically motivated:
 *  density        kg/m^3
 *  yieldStrength  MPa  (onset of permanent plastic bending)
 *  ultimate       MPa  (fracture / shear separation)
 *  toughness      0..1 how much plastic strain before separation
 * ------------------------------------------------------------------ */
export const METALS = {
  aluminium: {
    id: 'aluminium',
    label: 'Aluminium',
    density: 2700,
    yieldStrength: 55,
    ultimate: 110,
    toughness: 0.85,
    color: 0xb9bec4,
    roughness: 0.34,
    metalness: 1.0,
    anisotropy: 0.55,
    rust: 0.0,
    oxide: 0.22,
    sparkColor: 0xfff0c4,
    sparkYield: 0.45,
    pitch: 1.35
  },
  steel: {
    id: 'steel',
    label: 'Mild Steel',
    density: 7850,
    yieldStrength: 250,
    ultimate: 420,
    toughness: 0.62,
    color: 0x8d9298,
    roughness: 0.42,
    metalness: 1.0,
    anisotropy: 0.4,
    rust: 0.35,
    oxide: 0.1,
    sparkColor: 0xffc061,
    sparkYield: 1.0,
    pitch: 1.0
  },
  stainless: {
    id: 'stainless',
    label: 'Stainless',
    density: 8000,
    yieldStrength: 290,
    ultimate: 580,
    toughness: 0.7,
    color: 0xc3c8ce,
    roughness: 0.22,
    metalness: 1.0,
    anisotropy: 0.75,
    rust: 0.0,
    oxide: 0.05,
    sparkColor: 0xfff2d0,
    sparkYield: 0.8,
    pitch: 1.18
  },
  castIron: {
    id: 'castIron',
    label: 'Cast Iron',
    density: 7200,
    yieldStrength: 200,
    ultimate: 250,
    toughness: 0.16,
    color: 0x55585d,
    roughness: 0.66,
    metalness: 1.0,
    anisotropy: 0.15,
    rust: 0.55,
    oxide: 0.2,
    sparkColor: 0xffa33c,
    sparkYield: 1.25,
    pitch: 0.82
  },
  galvanised: {
    id: 'galvanised',
    label: 'Galvanised',
    density: 7100,
    yieldStrength: 180,
    ultimate: 320,
    toughness: 0.72,
    color: 0xa8aeb6,
    roughness: 0.5,
    metalness: 0.95,
    anisotropy: 0.3,
    rust: 0.12,
    oxide: 0.45,
    sparkColor: 0xdff0ff,
    sparkYield: 0.7,
    pitch: 1.1
  },
  copper: {
    id: 'copper',
    label: 'Copper',
    density: 8960,
    yieldStrength: 70,
    ultimate: 220,
    toughness: 0.95,
    color: 0xb87333,
    roughness: 0.3,
    metalness: 1.0,
    anisotropy: 0.6,
    rust: 0.0,
    oxide: 0.35,
    sparkColor: 0xffd9a0,
    sparkYield: 0.3,
    pitch: 1.05
  },
  hardened: {
    id: 'hardened',
    label: 'Hardened Tool Steel',
    density: 7900,
    yieldStrength: 1600,
    ultimate: 2100,
    toughness: 0.3,
    color: 0x6e747c,
    roughness: 0.28,
    metalness: 1.0,
    anisotropy: 0.85,
    rust: 0.08,
    oxide: 0.06,
    sparkColor: 0xffd08a,
    sparkYield: 1.0,
    pitch: 0.95
  }
};

/* ------------------------------------------------------------------ *
 * Shredder geometry — a twin-shaft low-speed / high-torque shear
 * shredder. All parts derive from these numbers so physics colliders,
 * visual meshes, VFX spawn points and audio all line up exactly.
 * ------------------------------------------------------------------ */
export const SHREDDER = {
  /** Distance between the two shaft centre lines (m). */
  shaftSpacing: 0.36,
  /** Height of the shaft centre lines above world origin (m). */
  shaftHeight: 0.62,
  /** Rotor cutter disc radius, not counting teeth (m). */
  discRadius: 0.19,
  /** Radial tip height of a tooth above the disc (m). */
  toothHeight: 0.055,
  /** Axial thickness of one cutter disc (m). */
  discThickness: 0.048,
  /** Axial gap between discs on the same shaft (discs interleave). */
  discGap: 0.052,
  /** Number of cutter discs per shaft. */
  discCount: 9,
  /** Teeth (hooks) per disc. */
  teethPerDisc: 5,
  /** Nominal shaft angular speed at 100% throttle (rad/s). */
  nominalOmega: 4.2,
  /** Maximum motor torque before stall (N·m). */
  stallTorque: 5200,
  /** Z extent of the cutting chamber (m). */
  chamberDepth: 0.9,
  /** Inner width of the hopper mouth (m). */
  hopperWidth: 1.25,
  hopperTop: 1.55,
  /** Conveyor deck. */
  conveyor: {
    length: 2.6,
    width: 0.86,
    height: 0.94,
    /** Metres per second at 100% speed. */
    maxSpeed: 0.85
  },
  /** Y level below which fragments are considered discharged. */
  dischargeY: -0.55
};

/** Y-plane of the shear line (where the two rotors meet). */
export const SHEAR_Y = SHREDDER.shaftHeight;

/* ------------------------------------------------------------------ */
export const PHYSICS = {
  gravity: [0, -9.82, 0],
  /** Fixed simulation timestep (s) — 120 Hz for stable high-speed shear. */
  fixedDt: 1 / 120,
  maxSubSteps: 4,
  /** Bodies below this speed for this long are allowed to sleep. */
  sleepLinearThreshold: 0.06,
  /** Contact impulse (N·s) above which we consider it a "hard" hit. */
  hardHitImpulse: 2.2,
  /** Max simultaneous dynamic bodies before oldest debris is culled. */
  maxBodies: 420
};

/* Transform stream layout, shared by worker + client.
 * [ id, px,py,pz, qx,qy,qz,qw, sleeping ] */
export const TRANSFORM_STRIDE = 9;

/* Contact stream layout.
 * [ idA, idB, px,py,pz, nx,ny,nz, impulse, relSpeed ] */
export const CONTACT_STRIDE = 10;
export const MAX_CONTACTS_PER_FRAME = 192;

/* ------------------------------------------------------------------ */
export const QUALITY_PRESETS = {
  ultra: {
    label: 'Ultra',
    pixelRatio: 2.0,
    ssao: true,
    ssaoSamples: 32,
    ssr: true,
    bloom: true,
    dof: true,
    shadowMapSize: 2048,
    maxSparks: 24000,
    anisotropicFiltering: 16,
    textureSize: 1024
  },
  high: {
    label: 'High',
    pixelRatio: 1.5,
    ssao: true,
    ssaoSamples: 16,
    ssr: true,
    bloom: true,
    dof: true,
    shadowMapSize: 2048,
    maxSparks: 16000,
    anisotropicFiltering: 8,
    textureSize: 1024
  },
  balanced: {
    label: 'Balanced',
    pixelRatio: 1.25,
    ssao: true,
    ssaoSamples: 8,
    ssr: false,
    bloom: true,
    dof: true,
    shadowMapSize: 1024,
    maxSparks: 9000,
    anisotropicFiltering: 4,
    textureSize: 512
  },
  performance: {
    label: 'Performance',
    pixelRatio: 1.0,
    ssao: false,
    ssaoSamples: 8,
    ssr: false,
    bloom: true,
    dof: false,
    shadowMapSize: 1024,
    maxSparks: 4500,
    anisotropicFiltering: 2,
    textureSize: 512
  }
};

export const CAMERA_PRESETS = {
  wide: {
    id: 'wide',
    label: 'Wide Factory',
    position: [3.05, 2.05, 3.35],
    target: [0, 0.78, 0],
    fov: 38,
    focusDistance: 4.4,
    aperture: 0.6
  },
  topDown: {
    id: 'topDown',
    label: 'Top Down',
    position: [0.001, 3.15, 0.42],
    target: [0, 0.7, 0],
    fov: 42,
    focusDistance: 2.6,
    aperture: 0.35
  },
  teeth: {
    id: 'teeth',
    label: 'Teeth-Eye',
    position: [0.52, 0.86, 0.86],
    target: [0, 0.68, 0],
    fov: 30,
    focusDistance: 1.1,
    aperture: 1.65
  },
  conveyor: {
    id: 'conveyor',
    label: 'Conveyor',
    position: [-1.05, 1.42, 2.15],
    target: [-0.35, 0.95, 0.55],
    fov: 34,
    focusDistance: 2.0,
    aperture: 0.9
  },
  discharge: {
    id: 'discharge',
    label: 'Discharge',
    position: [1.55, 0.12, 1.5],
    target: [0, 0.2, 0],
    fov: 40,
    focusDistance: 2.1,
    aperture: 1.0
  }
};

export const EVENTS = {
  /** { position:Vector3, normal:Vector3, energy:number, metal:string } */
  SHEAR: 'shear',
  /** { position:Vector3, impulse:number, metal:string, relSpeed:number } */
  IMPACT: 'impact',
  /** { load:0..1, rpm:number, stalled:boolean } */
  MOTOR_LOAD: 'motorLoad',
  /** { id:number } */
  FRAGMENT_SPAWN: 'fragmentSpawn',
  /** { metal:string, name:string } */
  SCRAP_SPAWN: 'scrapSpawn',
  /** { strength:number, duration:number } */
  SHAKE: 'shake',
  /** { preset:string } */
  QUALITY_CHANGED: 'qualityChanged',
  /** { fps:number, frameMs:number, bodies:number, drawCalls:number, tris:number } */
  STATS: 'stats',
  /** { key:string, value:any } */
  CONTROL: 'control'
};

export const DEG2RAD = Math.PI / 180;
