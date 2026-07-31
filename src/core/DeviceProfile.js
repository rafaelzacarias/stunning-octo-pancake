/**
 * DeviceProfile — one-shot capability probe that every budget in the app reads.
 *
 * This exists because the app used to boot every device at quality 'high',
 * which pins the procedural texture generator to 1024x1024. Measured on an
 * iPhone 14 viewport (390x844 @ DPR 3) that produced **742.9 MB of texture
 * uploads (995 MB with mipmaps)** plus 50.4 MB of renderbuffers, from 111
 * separate 1024x1024 uploads. iOS Safari reaps a tab well under 400 MB, so the
 * page was killed outright before it ever became interactive.
 *
 * Nothing here is a "nice to have" — every field is a hard allocation budget.
 * The profile is resolved ONCE, before the renderer or any texture exists, and
 * is treated as immutable for the session. Deriving texture size from the
 * mutable quality tier instead was the original bug: the adaptive guard drops
 * the tier under load, which regenerated the whole atlas at a new size while
 * the old one stayed resident, so memory pressure made memory pressure worse.
 */

const MOBILE_UA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i;

function readScreenShortSide() {
  // screen.width/height are the physical panel in CSS px and, unlike
  // innerWidth, do not change when the on-screen keyboard or URL bar moves.
  const w = (window.screen && window.screen.width) || window.innerWidth || 1024;
  const h = (window.screen && window.screen.height) || window.innerHeight || 768;
  return Math.min(w, h);
}

function detectTouch() {
  if (navigator.maxTouchPoints > 0) return true;
  if ('ontouchstart' in window) return true;
  return mq('(pointer: coarse)');
}

function mq(q) {
  try {
    return window.matchMedia(q).matches;
  } catch {
    return false;
  }
}

/**
 * iPadOS 13+ reports a desktop Macintosh UA string. The only reliable tell is
 * that a real Mac reports maxTouchPoints 0, so a "Macintosh" that reports ANY
 * touch points is an iPad.
 *
 * The usual snippet tests `> 1`, but the failure modes here are wildly
 * asymmetric: misreading a Mac as a tablet costs some visual quality, whereas
 * misreading an iPad as a desktop restores the 1024px atlas and kills the tab.
 * So this errs toward the handheld branch.
 *
 * Match `Macintosh` ONLY. Genuine iPhone/iPad UA strings contain the substring
 * "like Mac OS X", so a looser pattern captures them here and steals them from
 * the phone branch.
 */
function detectIPadOS() {
  return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
}

function probe() {
  const isTouch = detectTouch();
  const shortSide = readScreenShortSide();
  const uaMobile = MOBILE_UA.test(navigator.userAgent);
  const iPadOS = detectIPadOS();

  // Touch alone does NOT mean handheld. A 1920x1080 touchscreen laptop reports
  // 10 touch points and a 1080 short side, which would otherwise be classified
  // as a tablet and downgraded. The discriminator is that a laptop also has a
  // FINE pointer (trackpad/mouse); a phone or tablet has only a coarse one.
  // iPadOS with a trackpad keyboard is the exception, so the iPad tell wins.
  const hasFinePointer = mq('(any-pointer: fine)');
  const touchPrimary = isTouch && (!hasFinePointer || iPadOS || uaMobile);

  // A phone is a touch-primary device with a small panel. The UA check is a
  // backstop for browsers that lie about pointer type in desktop-mode.
  const isMobile = uaMobile || (touchPrimary && shortSide < 820 && !iPadOS);
  const isTablet = !isMobile && touchPrimary && (iPadOS || shortSide >= 820);

  // navigator.deviceMemory is Chromium-only and is capped at 8. Safari never
  // reports it, so `null` must not be read as "low".
  //
  // Core count is deliberately NOT part of this test: plenty of capable
  // desktops report hardwareConcurrency 4, and demoting them would be a
  // visible, unrequested downgrade.
  const deviceMemoryGB = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
  const cores = navigator.hardwareConcurrency || 4;
  const isLowPower = isMobile || (deviceMemoryGB !== null && deviceMemoryGB <= 4);

  let tier;
  if (isMobile) tier = 'low';
  else if (isTablet || isLowPower) tier = 'medium';
  else tier = 'high';

  // The single most important number in this file. 5 maps per material across
  // ~22 materials means the atlas cost is 110 * size^2 * 4 bytes * 1.34 (mips):
  //   1024 -> ~617 MB   512 -> ~154 MB   256 -> ~39 MB
  const maxTextureSize = isMobile ? 256 : isTablet ? 512 : 1024;

  // Phones are fill-rate bound long before they are triangle bound, and the
  // panel is already dense enough that 1.5x is indistinguishable from 3x.
  const maxPixelRatio = isMobile ? 1.5 : isTablet ? 2 : 2;

  return {
    isTouch,
    isMobile,
    isTablet,
    isLowPower,
    isIPadOS: iPadOS,
    deviceMemoryGB,
    cores,
    shortSide,

    tier,
    maxTextureSize,
    maxPixelRatio,

    // Rapier bodies are stepped on the CPU in a worker; a phone core does not
    // have the budget for the desktop count.
    maxScrapBodies: isMobile ? 45 : isTablet ? 75 : 110,
    maxFragments: isMobile ? 48 : isTablet ? 80 : 120,
    particleCapacity: isMobile ? 4096 : isTablet ? 8192 : 16384,
    dustCapacity: isMobile ? 1024 : isTablet ? 2048 : 4096,
    shadowMapCap: isMobile ? 1024 : isTablet ? 2048 : 4096,

    // A second WebGL context next to a memory-pressured main context is how
    // you get the main one evicted. It is also what forces EVERY material in
    // the library to exist at once (25 previews => all 22 texture sets), which
    // is the difference between "only what you spawned" and a fixed
    // 110-texture floor. Desktop only.
    allowThumbnails: !isMobile && !isTablet,
    // Transmission costs an extra full scene pass per transmissive material.
    allowTransmission: !isMobile,
    // Anisotropic filtering multiplies sampler cost on tiled mobile GPUs.
    textureAnisotropy: isMobile ? 1 : isTablet ? 4 : 8,
  };
}

let _cached = null;

/** Resolve (and memoise) the device profile. Safe to call before the renderer exists. */
export function detectDevice() {
  if (!_cached) _cached = probe();
  return _cached;
}

/**
 * Live profile. Imported directly by budget consumers.
 * Guarded so the module stays importable in Node for headless logic tests.
 */
export const DEVICE = typeof window !== 'undefined' && typeof navigator !== 'undefined'
  ? detectDevice()
  : {
    isTouch: false, isMobile: false, isTablet: false, isLowPower: false, isIPadOS: false,
    deviceMemoryGB: null, cores: 8, shortSide: 1080,
    tier: 'high', maxTextureSize: 1024, maxPixelRatio: 2,
    maxScrapBodies: 110, maxFragments: 120, particleCapacity: 16384, dustCapacity: 4096,
    shadowMapCap: 4096, allowThumbnails: true, allowTransmission: true, textureAnisotropy: 8,
  };

/**
 * Stamp capability + orientation classes onto <html> so style.css can react
 * without duplicating the detection logic. Returns a teardown function.
 */
export function applyDeviceClasses(el = document.documentElement) {
  const d = DEVICE;
  el.classList.toggle('sio-touch', d.isTouch);
  el.classList.toggle('sio-mobile', d.isMobile);
  el.classList.toggle('sio-tablet', d.isTablet);

  const sync = () => {
    const portrait = window.innerHeight >= window.innerWidth;
    el.classList.toggle('sio-portrait', portrait);
    el.classList.toggle('sio-landscape', !portrait);
  };
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  return () => {
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
  };
}
