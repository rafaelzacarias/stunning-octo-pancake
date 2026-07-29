import { bus } from '../core/EventBus.js';
import { EVENTS, METALS, SHREDDER } from '../core/Constants.js';
import { createNoiseBuffer, envAD, glide } from './Synths.js';
import { createImpulseResponse } from './ImpulseResponse.js';

/**
 * Fully procedural Web Audio engine for the shredder — zero audio files.
 *
 * A layered graph:
 *  - **Motor**: detuned saw + square + sub-sine at the shaft fundamental with
 *    harmonic partials, through a resonant low-pass. Pitch bends **down** and
 *    the filter opens up as `load` rises (the bogging-down groan), and an LFO at
 *    the blade-pass frequency (rpm × teeth) amplitude-modulates it so you hear
 *    the individual teeth chopping.
 *  - **Gearbox whine**: a quiet high partial tracking rpm.
 *  - **Scrape**: band-pass white noise whose centre/Q follow contact energy —
 *    only audible while material is in contact.
 *  - **Crunch / impact**: layered one-shot voices (a resonant noise "crack",
 *    detuned ringing partials tuned by the metal, and a low thump), randomised
 *    per hit, hard-capped and rate-limited, stereo-panned from world position.
 *  - **Strain**: when stalled, the motor sags, a sub-harmonic growl swells and
 *    an overload whine rises.
 *  - **Space**: a synthesised impulse response into a ConvolverNode, plus a bus
 *    compressor and a final limiter so nothing clips.
 *
 * The AudioContext is created lazily inside {@link AudioEngine#start} (called
 * from a user gesture) to respect autoplay policy. Every parameter change uses
 * `setTargetAtTime` / ramps — values are never assigned directly during
 * playback, so nothing clicks.
 */

const MAX_VOICES = 24;
const SHEAR_MIN_INTERVAL = 0.018; // s, per-event rate limit
const PAN_HALF_WIDTH = SHREDDER.hopperWidth * 0.9;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.muted = false;
    this.masterVolume = 0.8;

    // Latest motor telemetry (updated defensively from the bus).
    this._motor = { load: 0, rpm: 0, stalled: false, throttle: 0, reverse: false };
    this._contact = 0; // smoothed grinding-contact level 0..1
    this._voices = 0;
    this._lastShear = -1;

    this._subs = [
      bus.on(EVENTS.MOTOR_LOAD, (e) => this._onMotor(e)),
      bus.on(EVENTS.SHEAR, (e) => this._onShear(e)),
      bus.on(EVENTS.IMPACT, (e) => this._onImpact(e))
    ];
  }

  /* ----------------------------------------------------------------- */

  /** Create + resume the AudioContext and build the graph. Idempotent. */
  async start() {
    if (this.running) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this._build();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.running = true;
    this._applyMaster();
    this._startMotor();
  }

  async suspend() {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
    this.running = false;
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
      this.running = true;
    }
  }

  /* ----------------------------------------------------------------- */

  _build() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Master chain: bus -> compressor -> limiter -> master -> destination.
    this.busNode = ctx.createGain();
    this.busNode.gain.value = 1;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 8;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.14;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.05;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVolume;

    this.busNode.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // Reverb send: bus -> send -> convolver -> return -> compressor.
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createImpulseResponse(ctx, { duration: 1.4 });
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.busNode.connect(this.reverbSend);
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.compressor);

    // Shared looping noise source for scrape (and a template for one-shots).
    this._noiseBuffer = createNoiseBuffer(ctx, 2.2);

    this._buildMotor(now);
    this._buildScrape(now);
    this._buildStrain(now);
  }

  _buildMotor(now) {
    const ctx = this.ctx;
    // Filter with a resonant peak; cutoff/resonance track load.
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.frequency.value = 600;
    this.motorFilter.Q.value = 7;

    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0.0001;

    this.motorFilter.connect(this.motorGain);
    this.motorGain.connect(this.busNode);

    // Oscillator stack: saw + square + sub sine + two harmonic partials.
    const mkOsc = (type, gain, detune) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(this.motorFilter);
      return osc;
    };
    this._oscSaw = mkOsc('sawtooth', 0.5, -6);
    this._oscSquare = mkOsc('square', 0.28, +7);
    this._oscSub = mkOsc('sine', 0.6, 0);
    this._oscP2 = mkOsc('sine', 0.14, +2);
    this._oscP3 = mkOsc('triangle', 0.08, -3);

    // Blade-pass amplitude modulation (individual teeth chopping).
    this._amLfo = ctx.createOscillator();
    this._amLfo.type = 'sine';
    this._amLfo.frequency.value = 3.3;
    this._amDepth = ctx.createGain();
    this._amDepth.gain.value = 0.05;
    this._amLfo.connect(this._amDepth);
    this._amDepth.connect(this.motorGain.gain);

    // Gearbox whine — quiet, a couple of octaves up.
    this._whineOsc = ctx.createOscillator();
    this._whineOsc.type = 'triangle';
    this._whineFilter = ctx.createBiquadFilter();
    this._whineFilter.type = 'bandpass';
    this._whineFilter.frequency.value = 2400;
    this._whineFilter.Q.value = 6;
    this._whineGain = ctx.createGain();
    this._whineGain.gain.value = 0.0001;
    this._whineOsc.connect(this._whineFilter);
    this._whineFilter.connect(this._whineGain);
    this._whineGain.connect(this.busNode);
  }

  _buildScrape(now) {
    const ctx = this.ctx;
    this._scrapeSrc = ctx.createBufferSource();
    this._scrapeSrc.buffer = this._noiseBuffer;
    this._scrapeSrc.loop = true;
    this._scrapeFilter = ctx.createBiquadFilter();
    this._scrapeFilter.type = 'bandpass';
    this._scrapeFilter.frequency.value = 3200;
    this._scrapeFilter.Q.value = 9;
    this._scrapeGain = ctx.createGain();
    this._scrapeGain.gain.value = 0.0001;
    this._scrapeSrc.connect(this._scrapeFilter);
    this._scrapeFilter.connect(this._scrapeGain);
    this._scrapeGain.connect(this.busNode);
  }

  _buildStrain(now) {
    const ctx = this.ctx;
    // Sub-harmonic growl.
    this._growlOsc = ctx.createOscillator();
    this._growlOsc.type = 'sawtooth';
    this._growlOsc.frequency.value = 42;
    this._growlGain = ctx.createGain();
    this._growlGain.gain.value = 0.0001;
    this._growlOsc.connect(this._growlGain);
    this._growlGain.connect(this.busNode);

    // Rising overload whine.
    this._overOsc = ctx.createOscillator();
    this._overOsc.type = 'sawtooth';
    this._overOsc.frequency.value = 900;
    this._overFilter = ctx.createBiquadFilter();
    this._overFilter.type = 'bandpass';
    this._overFilter.frequency.value = 1800;
    this._overFilter.Q.value = 4;
    this._overGain = ctx.createGain();
    this._overGain.gain.value = 0.0001;
    this._overOsc.connect(this._overFilter);
    this._overFilter.connect(this._overGain);
    this._overGain.connect(this.busNode);
  }

  _startMotor() {
    if (this._motorStarted) return;
    this._motorStarted = true;
    const t = this.ctx.currentTime + 0.02;
    for (const o of [
      this._oscSaw, this._oscSquare, this._oscSub, this._oscP2, this._oscP3,
      this._amLfo, this._whineOsc, this._growlOsc, this._overOsc, this._scrapeSrc
    ]) {
      o.start(t);
    }
    this._applyMotor(this.ctx.currentTime);
  }

  /* ----------------------------------------------------------------- */

  _onMotor(e) {
    if (!e) return;
    this._motor.load = clamp01(e.load ?? 0);
    this._motor.rpm = Math.abs(e.rpm ?? 0);
    this._motor.stalled = !!e.stalled;
    this._motor.throttle = clamp01(e.throttle ?? (this._motor.rpm / SHREDDER.nominalOmega));
    this._motor.reverse = !!e.reverse;
    if (this.running) this._applyMotor(this.ctx.currentTime);
  }

  _applyMotor(now) {
    if (!this._motorStarted) return;
    const m = this._motor;
    const normRpm = clamp(m.rpm / SHREDDER.nominalOmega, 0, 1.5);

    // Audible fundamental derived from rpm; bends down under load / stall.
    let fund = 28 + 46 * clamp(normRpm, 0, 1);
    fund *= 1 - 0.22 * m.load;
    if (m.stalled) fund *= 0.62;
    fund = Math.max(18, fund);

    glide(this._oscSaw.frequency, fund, now, 0.06);
    glide(this._oscSquare.frequency, fund, now, 0.06);
    glide(this._oscSub.frequency, fund * 0.5, now, 0.06);
    glide(this._oscP2.frequency, fund * 2, now, 0.06);
    glide(this._oscP3.frequency, fund * 3, now, 0.06);

    // Blade-pass AM: rotation Hz × teeth per disc.
    const rotHz = m.rpm / (Math.PI * 2);
    const bladePass = Math.max(0.5, rotHz * SHREDDER.teethPerDisc);
    glide(this._amLfo.frequency, bladePass, now, 0.08);

    // Level rises with throttle; a little louder while grinding.
    const level = 0.05 + 0.16 * m.throttle + 0.06 * this._contact;
    glide(this.motorGain.gain, level, now, 0.05);
    glide(this._amDepth.gain, level * (0.35 + 0.4 * m.load), now, 0.06);

    // Filter: cutoff opens with rpm AND load (the classic bogging groan).
    const cutoff = (420 + 1500 * m.throttle) * (1 + 0.7 * m.load);
    glide(this.motorFilter.frequency, clamp(cutoff, 120, 9000), now, 0.05);
    glide(this.motorFilter.Q, 6 + 6 * m.load, now, 0.08);

    // Gearbox whine tracks rpm, quiet.
    glide(this._whineOsc.frequency, fund * 6, now, 0.06);
    glide(this._whineFilter.frequency, clamp(fund * 6, 200, 12000), now, 0.06);
    glide(this._whineGain.gain, 0.006 + 0.02 * m.throttle, now, 0.08);

    // Strain layers.
    if (m.stalled) {
      glide(this._growlOsc.frequency, fund * 0.5, now, 0.05);
      glide(this._growlGain.gain, 0.09, now, 0.05);
      glide(this._overGain.gain, 0.05, now, 0.2);
      // Overload whine slides upward while stalled.
      this._overOsc.frequency.setTargetAtTime(1400, now, 0.6);
    } else {
      glide(this._growlGain.gain, 0.0001, now, 0.12);
      glide(this._overGain.gain, 0.0001, now, 0.25);
      this._overOsc.frequency.setTargetAtTime(700, now, 0.4);
    }
  }

  _onShear(e) {
    if (!this.running || !e) return;
    const now = this.ctx.currentTime;
    if (now - this._lastShear < SHEAR_MIN_INTERVAL) return;
    this._lastShear = now;

    const energy = clamp01(e.energy ?? 0.5);
    this._contact = Math.min(1, this._contact + 0.25 + energy * 0.5);
    this._triggerCrunch(e.metal, energy, e.position, false);
  }

  _onImpact(e) {
    if (!this.running || !e) return;
    const strength = clamp01((e.impulse ?? 0.5) / 6);
    this._contact = Math.min(1, this._contact + 0.08 + strength * 0.2);
    if (strength > 0.06) this._triggerCrunch(e.metal, strength * 0.8, e.position, true);
  }

  /**
   * Fire a layered metallic one-shot voice: noise "crack" + ringing partials +
   * low thump, stereo-panned from world position and cleaned up on end.
   */
  _triggerCrunch(metalId, energy, position, light) {
    if (this._voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const metal = METALS[metalId] || METALS.steel;
    const pitch = metal.pitch ?? 1;
    const gainScale = (light ? 0.28 : 0.55) * (0.5 + energy);

    const nodes = [];
    const panner = ctx.createStereoPanner();
    panner.pan.value = position ? clamp((position.x || 0) / PAN_HALF_WIDTH, -1, 1) : 0;
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = gainScale;
    voiceGain.connect(panner);
    panner.connect(this.busNode);
    nodes.push(panner, voiceGain);

    // (a) Crack — short noise burst through a resonant band-pass.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (1800 + Math.random() * 2600) * pitch;
    bp.Q.value = 8 + Math.random() * 8;
    const crackGain = ctx.createGain();
    crackGain.gain.value = 0.0001;
    noise.connect(bp);
    bp.connect(crackGain);
    crackGain.connect(voiceGain);
    envAD(crackGain.gain, now, 0.9, 0.002, 0.05 + energy * 0.04);
    noise.start(now);
    nodes.push(noise, bp, crackGain);

    // (b) Clang — 3 detuned ringing partials tuned by the metal.
    const base = 240 * pitch;
    const partials = [1, 1.68, 2.71];
    const ringDecay = (light ? 0.12 : 0.28) + energy * 0.25;
    for (let i = 0; i < partials.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = base * partials[i] * (1 + (Math.random() - 0.5) * 0.02);
      osc.detune.value = (Math.random() - 0.5) * 12;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      osc.connect(g);
      g.connect(voiceGain);
      envAD(g.gain, now, 0.5 / (i + 1), 0.003, ringDecay * (1 - i * 0.2));
      osc.start(now);
      osc.stop(now + ringDecay + 0.1);
      nodes.push(osc, g);
    }

    // (c) Thump — low body.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90 + Math.random() * 30, now);
    thump.frequency.exponentialRampToValueAtTime(48, now + 0.12);
    const thumpGain = ctx.createGain();
    thumpGain.gain.value = 0.0001;
    thump.connect(thumpGain);
    thumpGain.connect(voiceGain);
    envAD(thumpGain.gain, now, light ? 0.2 : 0.45, 0.004, 0.12);
    thump.start(now);
    thump.stop(now + 0.25);
    nodes.push(thump, thumpGain);

    const stopAt = now + Math.max(ringDecay, 0.12) + 0.15;
    noise.stop(stopAt);

    this._voices++;
    const cleanup = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (_) { /* already gone */ }
      }
      nodes.length = 0;
      this._voices = Math.max(0, this._voices - 1);
    };
    noise.onended = cleanup;
  }

  /* ----------------------------------------------------------------- */

  update(dt) {
    if (!this.running) return;
    const now = this.ctx.currentTime;

    // Decay grinding-contact energy; gate the scrape layer by it.
    this._contact = Math.max(0, this._contact - dt * 1.6);
    const scrapeLevel = this._contact * (0.05 + 0.12 * this._motor.load);
    glide(this._scrapeGain.gain, Math.max(0.0001, scrapeLevel), now, 0.05);
    // Squeal rises in pitch and sharpens with contact energy.
    glide(this._scrapeFilter.frequency, 2200 + this._contact * 4200, now, 0.05);
    glide(this._scrapeFilter.Q, 6 + this._contact * 14, now, 0.06);
  }

  /* ----------------------------------------------------------------- */

  setMasterVolume(v) {
    this.masterVolume = clamp01(v);
    this._applyMaster();
  }

  setMuted(v) {
    this.muted = !!v;
    this._applyMaster();
  }

  _applyMaster() {
    if (!this.ctx || !this.master) return;
    const target = this.muted ? 0.0001 : Math.max(0.0001, this.masterVolume);
    glide(this.master.gain, target, this.ctx.currentTime, 0.03);
  }

  dispose() {
    for (const off of this._subs) off();
    this._subs.length = 0;
    if (!this.ctx) return;
    try {
      for (const o of [
        this._oscSaw, this._oscSquare, this._oscSub, this._oscP2, this._oscP3,
        this._amLfo, this._whineOsc, this._growlOsc, this._overOsc, this._scrapeSrc
      ]) {
        o?.stop?.();
      }
    } catch (_) { /* not started */ }
    this.ctx.close();
    this.ctx = null;
    this.running = false;
  }
}

/* ------------------------------------------------------------------ */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
