#!/usr/bin/env node
/**
 * Headless visual-QA harness for the metal shredder simulator.
 *
 * Boots the production build in headless Chromium, drives a scripted shredding
 * scenario, and captures reference frames plus performance telemetry into
 * `qa/shots/` and `qa/report.json`.
 *
 * Two capture passes:
 *   ACTION  — small viewport, Performance preset. The software rasteriser can
 *             actually keep up here, so the simulation makes real progress and
 *             we see motion: sparks in flight, fragments falling, teeth biting.
 *   BEAUTY  — larger viewport, Ultra preset, single frame of an already-staged
 *             scene. Slow (tens of seconds per frame under SwiftShader) but it
 *             is what the visual critic grades for material/lighting fidelity.
 *
 * IMPORTANT: headless Chromium rasterises with SwiftShader on the CPU, so the
 * FPS reported here says nothing about GPU hardware. The transferable number is
 * `simMs` — simulation + scene-update cost with rendering excluded.
 *
 * Usage: npm run build && node qa/capture.mjs [--dev] [--no-beauty]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHOTS = join(__dirname, 'shots');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run: npm install');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const PORT = DEV ? 5173 : 4173;
const URL = `http://127.0.0.1:${PORT}/`;

const CHROME_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio'
];

/** Frames the critic loop grades. `beauty: true` re-shoots at Ultra. */
const SCENARIOS = [
  { name: '01-wide-idle', preset: 'wide', feed: 0, run: 3, beauty: true },
  { name: '02-wide-shredding', preset: 'wide', feed: 5, run: 10, beauty: true },
  { name: '03-teeth-closeup', preset: 'teeth', feed: 4, run: 8, beauty: true },
  { name: '04-topdown', preset: 'topDown', feed: 4, run: 8 },
  { name: '05-conveyor', preset: 'conveyor', feed: 3, run: 6 },
  { name: '06-discharge', preset: 'discharge', feed: 4, run: 9 },
  { name: '07-castiron-engine', preset: 'teeth', feed: 2, run: 9, type: 'engine', beauty: true },
  { name: '08-beam-shear', preset: 'teeth', feed: 3, run: 8, type: 'ibeam', beauty: true },
  { name: '09-aluminium-cans', preset: 'wide', feed: 8, run: 8, type: 'can' }
];

function startServer() {
  const cmd = DEV ? ['run', 'dev', '--', '--port', String(PORT)] : ['run', 'preview'];
  const proc = spawn('npm', cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 60s')), 60000);
    const onData = (buf) => {
      if (buf.toString().includes(String(PORT))) {
        clearTimeout(timer);
        setTimeout(() => resolve(proc), 500);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
  });
}

const readStats = (page) =>
  page.evaluate(() => {
    const app = window.__shredder;
    const r = (v) => Math.round((v ?? 0) * 100) / 100;
    return {
      fps: r(app.perf.fps),
      frameMs: r(app.perf.frameMs),
      frameMs95: r(app.perf.frameMs95),
      cpuMs: r(app.perf.cpuMs),
      simMs: r(app.perf.simMs),
      longFrames: app.perf.longFrames,
      drawCalls: app.perf.extra.drawCalls,
      tris: app.perf.extra.tris,
      bodies: app.perf.extra.bodies,
      fragments: app.perf.extra.fragments,
      sparks: app.perf.extra.sparks,
      quality: app.quality.presetName
    };
  });

/**
 * Playwright's own screenshot waits for two stable animation frames, which
 * never happens while the software rasteriser is grinding. Go straight to CDP
 * and grab whatever was last composited.
 */
async function capture(cdp, path) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
}

async function main() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: CHROME_ARGS,
    headless: true
  });

  const report = {
    url: URL,
    startedAt: new Date().toISOString(),
    note: 'Headless SwiftShader: fps/cpuMs are CPU-raster bound. simMs is the GPU-independent number.',
    console: [],
    errors: [],
    shots: []
  };

  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const cdp = await page.context().newCDPSession(page);

    page.on('console', (m) => {
      report.console.push({ type: m.type(), text: m.text() });
      if (m.type() === 'error') console.error('  [console]', m.text());
    });
    page.on('pageerror', (e) => {
      report.errors.push(String(e));
      console.error('  [pageerror]', e.message);
    });

    console.log(`→ opening ${URL}`);
    await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__shredder?.running === true, null, { timeout: 240000 });
    console.log('→ app running');

    await page.evaluate(async () => {
      document.getElementById('start-button')?.click();
      await window.__shredder?.engage?.();
      window.__shredder?.ui?.setVisible?.(false);
      window.__shredder?.quality?.setPreset?.('performance');
    });

    for (const scene of SCENARIOS) {
      console.log(`→ ${scene.name}`);
      await page.evaluate((s) => {
        const app = window.__shredder;
        app.perf.reset();
        app.cameraRig?.setPreset?.(s.preset, { instant: true });
        app.rig?.setPower?.(true);
        app.rig?.setThrottle?.(1);
        for (let i = 0; i < (s.feed || 0); i++) app.feeder?.spawn?.(s.type);
      }, scene);

      await page.waitForTimeout(scene.run * 1000);
      const stats = await readStats(page);
      await capture(cdp, join(SHOTS, `${scene.name}.png`));
      report.shots.push({ ...scene, pass: 'action', stats });
      console.log(
        `   fps=${stats.fps} sim=${stats.simMs}ms draws=${stats.drawCalls} ` +
          `tris=${stats.tris} bodies=${stats.bodies} frags=${stats.fragments} sparks=${stats.sparks}`
      );
    }

    // ---- Sustained-load stress ----
    console.log('→ stress: auto-feed flood');
    await page.evaluate(() => {
      const app = window.__shredder;
      app.perf.reset();
      app.cameraRig?.setPreset?.('wide', { instant: true });
      app.feeder?.setAutoFeed?.(true);
      app.feeder?.setConveyorSpeed?.(1);
    });
    await page.waitForTimeout(25000);
    report.stress = await readStats(page);
    await capture(cdp, join(SHOTS, '10-stress.png'));
    console.log('   ', JSON.stringify(report.stress));
    await page.evaluate(() => window.__shredder?.feeder?.setAutoFeed?.(false));

    // ---- Beauty pass: full effect chain, one frame per staged scene ----
    if (!args.has('--no-beauty')) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(() => {
        const app = window.__shredder;
        app.quality?.setPreset?.('ultra');
        app.quality?.setAuto?.(false);
      });

      for (const scene of SCENARIOS.filter((s) => s.beauty)) {
        console.log(`→ beauty ${scene.name}`);
        await page.evaluate((s) => {
          const app = window.__shredder;
          app.cameraRig?.setPreset?.(s.preset, { instant: true });
          for (let i = 0; i < Math.min(3, s.feed || 0); i++) app.feeder?.spawn?.(s.type);
        }, scene);
        await page.waitForTimeout(20000);
        await capture(cdp, join(SHOTS, `beauty-${scene.name}.png`));
        report.shots.push({ ...scene, pass: 'beauty', stats: await readStats(page) });
      }
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  report.finishedAt = new Date().toISOString();
  writeFileSync(join(__dirname, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n✓ captured → qa/shots/');
  if (report.errors.length) {
    console.error(`✗ ${report.errors.length} page errors — see qa/report.json`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
