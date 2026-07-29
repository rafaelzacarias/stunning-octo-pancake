/**
 * AudioEngine — fully procedural industrial audio for a metal shredding simulator.
 *
 * No assets, no dependencies, no network. Everything is synthesized with the
 * Web Audio API at runtime: motor drivetrain, gear whine, steel-on-steel scrape,
 * layered impacts, sheet-metal tears, spark crackle and pneumatic hiss, glued
 * together through a compressor bus and a procedurally generated concrete-hall
 * convolution reverb.
 */

const SILENCE = 1e-4; // floor used to keep exponential ramps legal
const MAX_VOICES = 24;

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const safe = (v) => (v > SILENCE ? v : SILENCE);

export class AudioEngine {
	constructor() {
		/** @type {AudioContext|null} */
		this.ctx = null;
		this._started = false;
		this._disposed = false;
		this._muted = true;
		this._masterVolume = 0.85;

		// ---- continuous control state (targets vs smoothed values) ----
		this._power = false;
		this._reverse = false;
		this._rpmTarget = 0; // 0..1
		this._rpm = 0; // smoothed
		this._rpmOvershoot = 0; // governor kick when load is released
		this._loadTarget = 0;
		this._load = 0;
		this._prevLoadTarget = 0;
		this._conveyorTarget = 0;
		this._conveyor = 0;
		this._scrapeTarget = 0;
		this._scrape = 0;

		// ---- node handles (all created in start()) ----
		this.master = null;
		this.compressor = null;
		this._preLimiter = null;
		this.bus = null;
		this.reverbSend = null;
		this.convolver = null;
		this.reverbReturn = null;

		this._noiseWhite = null;
		this._noisePink = null;
		this._impulse = null;

		this._motor = null;
		this._gear = null;
		this._mains = null;
		this._scrapeChain = null;
		this._conveyorChain = null;

		/** @type {Array<{gain: GainNode, stop: () => void, level: number, t: number}>} */
		this._voices = [];

		this._lastWobble = 0;
	}

	/** True once start() has completed and the engine has not been disposed. */
	get isRunning() {
		return this._started && !this._disposed && !!this.ctx && this.ctx.state !== 'closed';
	}

	/**
	 * Create/resume the AudioContext and build the full signal graph.
	 * Must be called from a user gesture.
	 * @returns {Promise<void>}
	 */
	async start() {
		if (this._disposed) return;
		if (this._started) {
			if (this.ctx && this.ctx.state === 'suspended') {
				try {
					await this.ctx.resume();
				} catch { /* ignore */ }
			}
			return;
		}

		const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
		if (!Ctor) return;

		const ctx = new Ctor({ latencyHint: 'interactive' });
		this.ctx = ctx;
		if (ctx.state === 'suspended') {
			try {
				await ctx.resume();
			} catch { /* autoplay policy — caller retries from a gesture */ }
		}

		const now = ctx.currentTime;

		// ---------------- master chain ----------------
		this.master = ctx.createGain();
		this.master.gain.setValueAtTime(this._muted ? SILENCE : safe(this._masterVolume), now);
		this.master.connect(ctx.destination);

		// Industrial "glue": slow-ish attack so transients punch, hard ratio so the
		// mix never runs away when a dozen impacts land at once.
		this.compressor = ctx.createDynamicsCompressor();
		this.compressor.threshold.setValueAtTime(-16, now);
		this.compressor.knee.setValueAtTime(8, now);
		this.compressor.ratio.setValueAtTime(8, now);
		this.compressor.attack.setValueAtTime(0.004, now);
		this.compressor.release.setValueAtTime(0.18, now);
		this.compressor.connect(this.master);

		// Gentle safety saturator before the compressor keeps peaks tame.
		this._preLimiter = ctx.createWaveShaper();
		this._preLimiter.curve = this._makeSaturationCurve(0.45, 2048);
		this._preLimiter.oversample = '2x';
		this._preLimiter.connect(this.compressor);

		this.bus = ctx.createGain();
		this.bus.gain.setValueAtTime(0.9, now);
		this.bus.connect(this._preLimiter);

		// ---------------- reverb send ----------------
		this._noiseWhite = this._makeNoiseBuffer(4.0, false);
		this._noisePink = this._makeNoiseBuffer(4.0, true);
		this._impulse = this._makeImpulseResponse(1.6);

		this.convolver = ctx.createConvolver();
		this.convolver.normalize = true;
		this.convolver.buffer = this._impulse;

		this.reverbSend = ctx.createGain();
		this.reverbSend.gain.setValueAtTime(0.18, now); // dry/wet mix
		this.bus.connect(this.reverbSend);
		this.reverbSend.connect(this.convolver);

		// Roll the tail off so the hall stays dark and concrete-like.
		const revTone = ctx.createBiquadFilter();
		revTone.type = 'lowpass';
		revTone.frequency.setValueAtTime(4200, now);
		revTone.Q.setValueAtTime(0.5, now);
		const revHP = ctx.createBiquadFilter();
		revHP.type = 'highpass';
		revHP.frequency.setValueAtTime(120, now);
		this.convolver.connect(revHP);
		revHP.connect(revTone);

		this.reverbReturn = ctx.createGain();
		this.reverbReturn.gain.setValueAtTime(1.0, now);
		revTone.connect(this.reverbReturn);
		this.reverbReturn.connect(this._preLimiter);
		this._revTone = revTone;
		this._revHP = revHP;

		// ---------------- persistent layers ----------------
		this._buildMotor();
		this._buildGearWhine();
		this._buildMains();
		this._buildScrapeBed();
		this._buildConveyor();

		this._started = true;

		// Apply any state that was set before start().
		this.setPower(this._power);
		this.setReverse(this._reverse);
		return undefined;
	}

	// =====================================================================
	// Buffers
	// =====================================================================

	/**
	 * One reusable noise buffer per flavour; every noise source in the engine
	 * plays a random offset into these instead of allocating per-shot.
	 */
	_makeNoiseBuffer(seconds, pink) {
		const ctx = this.ctx;
		const sr = ctx.sampleRate;
		const len = Math.floor(sr * seconds);
		const buf = ctx.createBuffer(1, len, sr);
		const d = buf.getChannelData(0);

		if (!pink) {
			for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
			return buf;
		}

		// Paul Kellet's pink noise approximation.
		let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
		for (let i = 0; i < len; i++) {
			const w = Math.random() * 2 - 1;
			b0 = 0.99886 * b0 + w * 0.0555179;
			b1 = 0.99332 * b1 + w * 0.0750759;
			b2 = 0.969 * b2 + w * 0.153852;
			b3 = 0.8665 * b3 + w * 0.3104856;
			b4 = 0.55 * b4 + w * 0.5329522;
			b5 = -0.7616 * b5 - w * 0.016898;
			const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
			b6 = w * 0.115926;
			d[i] = clamp(out, -1, 1);
		}
		return buf;
	}

	/**
	 * Procedural IR: exponentially decaying, lowpass-shaped noise with a few
	 * early reflections — reads as a large empty concrete hall.
	 */
	_makeImpulseResponse(seconds) {
		const ctx = this.ctx;
		const sr = ctx.sampleRate;
		const len = Math.max(1, Math.floor(sr * seconds));
		const buf = ctx.createBuffer(2, len, sr);

		const reflections = [0.011, 0.019, 0.031, 0.047, 0.068, 0.091, 0.127];

		for (let ch = 0; ch < 2; ch++) {
			const d = buf.getChannelData(ch);
			// one-pole lowpass state per channel for a darker, "stone room" tail
			let lp = 0;
			const detune = ch === 0 ? 1.0 : 1.04;
			for (let i = 0; i < len; i++) {
				const t = i / len;
				const decay = Math.pow(1 - t, 2.6) * Math.exp(-3.2 * t);
				const w = Math.random() * 2 - 1;
				lp += (w - lp) * 0.34;
				d[i] = lp * decay;
			}
			for (const r of reflections) {
				const idx = Math.floor(r * detune * sr);
				if (idx < len) {
					const amp = 0.55 * Math.pow(1 - idx / len, 2.0) * (Math.random() * 0.6 + 0.7);
					d[idx] += (Math.random() < 0.5 ? -amp : amp);
				}
			}
			// slight pre-delay fade-in so the onset is not a click
			const fade = Math.floor(sr * 0.004);
			for (let i = 0; i < fade && i < len; i++) d[i] *= i / fade;
		}
		return buf;
	}

	/** tanh-style soft clip curve for the motor strain / limiter stages. */
	_makeSaturationCurve(drive, samples = 4096) {
		const curve = new Float32Array(samples);
		const k = Math.max(0.0001, drive) * 6;
		for (let i = 0; i < samples; i++) {
			const x = (i / (samples - 1)) * 2 - 1;
			curve[i] = Math.tanh(k * x) / Math.tanh(k);
		}
		return curve;
	}

	/** Shared helper: a looping noise source starting at a random buffer offset. */
	_noiseSource(pink = false, loop = true, playbackRate = 1) {
		const src = this.ctx.createBufferSource();
		const buf = pink ? this._noisePink : this._noiseWhite;
		src.buffer = buf;
		src.loop = loop;
		src.playbackRate.setValueAtTime(playbackRate, this.ctx.currentTime);
		// Random read offset so repeated one-shots never replay identical noise.
		src._offset = buf ? Math.random() * buf.duration * 0.9 : 0;
		return src;
	}

	// =====================================================================
	// Persistent layers
	// =====================================================================

	_buildMotor() {
		const ctx = this.ctx;
		const now = ctx.currentTime;

		const out = ctx.createGain();
		out.gain.setValueAtTime(SILENCE, now);

		// Waveshaper drive stage — grows with throat load into a growl.
		const shaper = ctx.createWaveShaper();
		shaper.curve = this._makeSaturationCurve(1.0);
		shaper.oversample = '4x';

		const preDrive = ctx.createGain();
		preDrive.gain.setValueAtTime(1.0, now);

		const postDrive = ctx.createGain();
		postDrive.gain.setValueAtTime(0.7, now);

		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime(180, now);
		lp.Q.setValueAtTime(6.5, now); // resonant — gives the drivetrain body

		const hp = ctx.createBiquadFilter();
		hp.type = 'highpass';
		hp.frequency.setValueAtTime(22, now);

		// Body resonance of the housing.
		const body = ctx.createBiquadFilter();
		body.type = 'peaking';
		body.frequency.setValueAtTime(96, now);
		body.Q.setValueAtTime(3.0, now);
		body.gain.setValueAtTime(6, now);

		preDrive.connect(shaper);
		shaper.connect(postDrive);
		postDrive.connect(lp);
		lp.connect(body);
		body.connect(hp);
		hp.connect(out);
		out.connect(this.bus);

		// 4 detuned oscillators: 2 saw (harmonic-rich), 2 square (hollow core).
		const specs = [
			{ type: 'sawtooth', mult: 1.0, detune: -7, gain: 0.55 },
			{ type: 'sawtooth', mult: 2.0, detune: 9, gain: 0.24 },
			{ type: 'square', mult: 1.0, detune: 4, gain: 0.30 },
			{ type: 'square', mult: 3.0, detune: -11, gain: 0.10 },
			{ type: 'sawtooth', mult: 0.5, detune: 0, gain: 0.32 },
		];
		const oscs = [];
		for (const s of specs) {
			const osc = ctx.createOscillator();
			osc.type = s.type;
			osc.frequency.setValueAtTime(28 * s.mult, now);
			osc.detune.setValueAtTime(s.detune, now);
			const g = ctx.createGain();
			g.gain.setValueAtTime(s.gain, now);
			osc.connect(g);
			g.connect(preDrive);
			osc.start(now);
			oscs.push({ osc, gain: g, mult: s.mult });
		}

		// Slow amplitude wobble = rotating imbalance.
		const lfo = ctx.createOscillator();
		lfo.type = 'sine';
		lfo.frequency.setValueAtTime(4.2, now);
		const lfoAmt = ctx.createGain();
		lfoAmt.gain.setValueAtTime(0.05, now);
		lfo.connect(lfoAmt);
		lfoAmt.connect(out.gain);
		lfo.start(now);

		this._motor = { out, oscs, lp, shaper, preDrive, postDrive, body, hp, lfo, lfoAmt, base: 28 };
	}

	_buildGearWhine() {
		const ctx = this.ctx;
		const now = ctx.currentTime;

		const out = ctx.createGain();
		out.gain.setValueAtTime(SILENCE, now);
		out.connect(this.bus);

		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.setValueAtTime(320, now);
		bp.Q.setValueAtTime(14, now); // narrow — mechanical tone, not a pad

		const bp2 = ctx.createBiquadFilter();
		bp2.type = 'bandpass';
		bp2.frequency.setValueAtTime(640, now);
		bp2.Q.setValueAtTime(9, now);

		bp.connect(bp2);
		bp2.connect(out);

		const oscs = [];
		for (const spec of [
			{ mult: 8.0, detune: 0, gain: 0.5 },
			{ mult: 11.0, detune: 6, gain: 0.3 },
			{ mult: 14.0, detune: -8, gain: 0.18 },
		]) {
			const osc = ctx.createOscillator();
			osc.type = 'sawtooth';
			osc.frequency.setValueAtTime(28 * spec.mult, now);
			osc.detune.setValueAtTime(spec.detune, now);
			const g = ctx.createGain();
			g.gain.setValueAtTime(spec.gain, now);
			osc.connect(g);
			g.connect(bp);
			osc.start(now);
			oscs.push({ osc, mult: spec.mult });
		}

		// Wobble the whine so gear mesh sounds alive rather than a sine tone.
		const wobble = ctx.createOscillator();
		wobble.type = 'sine';
		wobble.frequency.setValueAtTime(0.7, now);
		const wobbleAmt = ctx.createGain();
		wobbleAmt.gain.setValueAtTime(18, now);
		wobble.connect(wobbleAmt);
		wobbleAmt.connect(bp.frequency);
		wobbleAmt.connect(bp2.frequency);
		wobble.start(now);

		this._gear = { out, oscs, bp, bp2, wobble, wobbleAmt };
	}

	_buildMains() {
		const ctx = this.ctx;
		const now = ctx.currentTime;

		const out = ctx.createGain();
		out.gain.setValueAtTime(SILENCE, now);
		out.connect(this.bus);

		const osc = ctx.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(120, now); // 2x mains
		const osc2 = ctx.createOscillator();
		osc2.type = 'triangle';
		osc2.frequency.setValueAtTime(240, now);
		const g2 = ctx.createGain();
		g2.gain.setValueAtTime(0.25, now);

		osc.connect(out);
		osc2.connect(g2);
		g2.connect(out);
		osc.start(now);
		osc2.start(now);

		this._mains = { out, osc, osc2, g2 };
	}

	_buildScrapeBed() {
		const ctx = this.ctx;
		const now = ctx.currentTime;

		const out = ctx.createGain();
		out.gain.setValueAtTime(SILENCE, now);
		out.connect(this.bus);

		const src = this._noiseSource(false, true, 1);

		// Three cascaded bandpasses; centres get jittered every update().
		const bands = [];
		let node = src;
		for (const [f, q] of [[2400, 5.5], [3800, 7], [5600, 6]]) {
			const bp = ctx.createBiquadFilter();
			bp.type = 'bandpass';
			bp.frequency.setValueAtTime(f, now);
			bp.Q.setValueAtTime(q, now);
			node.connect(bp);
			node = bp;
			bands.push(bp);
		}

		// The shriek: very narrow, high-Q peak that glides around.
		const shriek = ctx.createBiquadFilter();
		shriek.type = 'peaking';
		shriek.frequency.setValueAtTime(4200, now);
		shriek.Q.setValueAtTime(26, now);
		shriek.gain.setValueAtTime(16, now);
		node.connect(shriek);

		// Low grind bed under the shriek so it has weight.
		const grindSrc = this._noiseSource(true, true, 0.85);
		const grindBP = ctx.createBiquadFilter();
		grindBP.type = 'bandpass';
		grindBP.frequency.setValueAtTime(420, now);
		grindBP.Q.setValueAtTime(1.4, now);
		const grindGain = ctx.createGain();
		grindGain.gain.setValueAtTime(0.55, now);
		grindSrc.connect(grindBP);
		grindBP.connect(grindGain);

		const shaper = ctx.createWaveShaper();
		shaper.curve = this._makeSaturationCurve(0.9);
		shaper.oversample = '4x';
		shriek.connect(shaper);
		grindGain.connect(shaper);
		shaper.connect(out);

		src.start(now + rand(0, 0.05), src._offset || 0);
		grindSrc.start(now + rand(0, 0.05), grindSrc._offset || 0);

		this._scrapeChain = { out, src, grindSrc, bands, shriek, grindBP, grindGain, shaper, phase: 0 };
	}

	_buildConveyor() {
		const ctx = this.ctx;
		const now = ctx.currentTime;

		const out = ctx.createGain();
		out.gain.setValueAtTime(SILENCE, now);
		out.connect(this.bus);

		// Rubber belt rumble: pink noise through a low lowpass + resonant peak.
		const src = this._noiseSource(true, true, 0.6);
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime(140, now);
		lp.Q.setValueAtTime(3.5, now);
		const thump = ctx.createBiquadFilter();
		thump.type = 'peaking';
		thump.frequency.setValueAtTime(62, now);
		thump.Q.setValueAtTime(2.2, now);
		thump.gain.setValueAtTime(9, now);
		src.connect(lp);
		lp.connect(thump);
		thump.connect(out);

		// Roller squeak: narrow bandpass on noise, slowly swept.
		const squeakSrc = this._noiseSource(false, true, 1);
		const squeakBP = ctx.createBiquadFilter();
		squeakBP.type = 'bandpass';
		squeakBP.frequency.setValueAtTime(2100, now);
		squeakBP.Q.setValueAtTime(24, now);
		const squeakGain = ctx.createGain();
		squeakGain.gain.setValueAtTime(0.06, now);
		squeakSrc.connect(squeakBP);
		squeakBP.connect(squeakGain);
		squeakGain.connect(out);

		const squeakLFO = ctx.createOscillator();
		squeakLFO.type = 'triangle';
		squeakLFO.frequency.setValueAtTime(0.23, now);
		const squeakLFOAmt = ctx.createGain();
		squeakLFOAmt.gain.setValueAtTime(340, now);
		squeakLFO.connect(squeakLFOAmt);
		squeakLFOAmt.connect(squeakBP.frequency);

		src.start(now + rand(0, 0.05), src._offset || 0);
		squeakSrc.start(now + rand(0, 0.05), squeakSrc._offset || 0);
		squeakLFO.start(now);

		this._conveyorChain = { out, src, lp, thump, squeakSrc, squeakBP, squeakGain, squeakLFO, squeakLFOAmt };
	}

	// =====================================================================
	// Voice management
	// =====================================================================

	_canVoice() {
		if (!this.isRunning) return false;
		this._reapVoices();
		if (this._voices.length < MAX_VOICES) return true;
		// Steal the quietest voice.
		let idx = 0;
		for (let i = 1; i < this._voices.length; i++) {
			if (this._voices[i].level < this._voices[idx].level) idx = i;
		}
		const victim = this._voices[idx];
		this._voices.splice(idx, 1);
		try {
			victim.stop();
		} catch { /* already gone */ }
		return true;
	}

	_reapVoices() {
		const t = this.ctx.currentTime;
		for (let i = this._voices.length - 1; i >= 0; i--) {
			const v = this._voices[i];
			if (v.dead) {
				this._voices.splice(i, 1);
			} else if (v.t <= t) {
				// Safety net: onended never fired (e.g. suspended context).
				this._voices.splice(i, 1);
				try {
					v.stop();
				} catch { /* ignore */ }
			}
		}
	}

	/**
	 * Register a one-shot voice: a gain node feeding the bus plus a teardown
	 * routine that is guaranteed to run exactly once, either when every source
	 * has finished or when the voice is stolen by the allocator.
	 */
	_voice(duration, level) {
		const ctx = this.ctx;
		const now = ctx.currentTime;
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(SILENCE, now);
		gain.connect(this.bus);

		const sources = [];
		const nodes = [gain];
		let killed = false;
		let pending = 0;

		const entry = {
			gain,
			level,
			t: now + duration + 0.25,
			dead: false,
			stop: () => {
				if (killed) return;
				killed = true;
				entry.dead = true;
				let t = 0;
				try {
					t = ctx.currentTime;
					gain.gain.cancelScheduledValues(t);
					gain.gain.setTargetAtTime(SILENCE, t, 0.008);
				} catch { /* context gone */ }
				for (const s of sources) {
					try {
						s.stop(t + 0.04);
					} catch { /* already stopped */ }
				}
				setTimeout(() => {
					for (const n of nodes) {
						try {
							n.disconnect();
						} catch { /* ignore */ }
					}
					sources.length = 0;
					nodes.length = 0;
				}, 120);
			},
		};

		this._voices.push(entry);

		return {
			gain,
			/** track a node so it gets disconnected on teardown */
			track: (n) => {
				nodes.push(n);
				return n;
			},
			/** schedule a source; the voice tears down once every source has ended */
			play: (src, startAt, stopAt) => {
				sources.push(src);
				nodes.push(src);
				pending++;
				src.onended = () => {
					pending--;
					if (pending <= 0) entry.stop();
				};
				try {
					if (src.buffer) src.start(startAt, src._offset || 0);
					else src.start(startAt);
					src.stop(stopAt);
				} catch {
					pending--;
				}
				return src;
			},
			end: entry.stop,
		};
	}

	// =====================================================================
	// Public control API
	// =====================================================================

	/**
	 * Set master output volume.
	 * @param {number} v 0..1
	 */
	setMasterVolume(v) {
		this._masterVolume = clamp(num(v, 0));
		if (!this.isRunning) return;
		const target = this._muted ? SILENCE : safe(this._masterVolume);
		this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
	}

	/**
	 * Mute or unmute the whole engine (does not stop synthesis).
	 * @param {boolean} m
	 */
	setMuted(m) {
		this._muted = !!m;
		if (!this.isRunning) return;
		const target = this._muted ? SILENCE : safe(this._masterVolume);
		this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
	}

	/**
	 * Spin the shredder motor up (~1.4s) or coast it down (~2.2s).
	 * @param {boolean} on
	 */
	setPower(on) {
		const next = !!on;
		const changed = next !== this._power;
		this._power = next;
		this._rpmTarget = next ? 1 : 0;
		if (!this.isRunning) return;
		if (changed) {
			// Contactor snap on power state change.
			this._relayClunk(next ? 1 : 0.7);
		}
	}

	/**
	 * Reverse the drum direction: slight pitch/timbre shift + relay clunk.
	 * @param {boolean} on
	 */
	setReverse(on) {
		const next = !!on;
		const changed = next !== this._reverse;
		this._reverse = next;
		if (!this.isRunning) return;
		if (changed) {
			this._relayClunk(0.85);
			const now = this.ctx.currentTime;
			// Brief RPM dip as the drive changes direction.
			this._rpmOvershoot -= 0.22;
			this._gear.bp.Q.setTargetAtTime(next ? 20 : 14, now, 0.25);
		}
	}

	/**
	 * Continuous motor strain from material in the throat.
	 * @param {number} load 0..1
	 */
	setThroatLoad(load) {
		const v = clamp(num(load, 0));
		// Governor: releasing load kicks RPM slightly above nominal.
		if (v < this._prevLoadTarget - 0.08) {
			this._rpmOvershoot += (this._prevLoadTarget - v) * 0.5;
			if (this._rpmOvershoot > 0.22) this._rpmOvershoot = 0.22;
		}
		this._prevLoadTarget = v;
		this._loadTarget = v;
	}

	/**
	 * Conveyor belt speed: rubber rumble + roller squeak layer.
	 * @param {number} s 0..1
	 */
	setConveyorSpeed(s) {
		this._conveyorTarget = clamp(num(s, 0));
	}

	/**
	 * Feed the continuous scrape bed. Call every frame while metal is grinding.
	 * @param {number} intensity 0..1
	 */
	scrape(intensity) {
		const v = clamp(num(intensity, 0));
		if (v > this._scrapeTarget) this._scrapeTarget = v;
		else this._scrapeTarget = this._scrapeTarget * 0.6 + v * 0.4;
	}

	/**
	 * One-shot impact: body thump + inharmonic clang partials + crushed crackle.
	 * @param {number} intensity 0..1
	 * @param {number} hardness 0..1 (0 = soft aluminium, 1 = hardened steel)
	 */
	impact(intensity, hardness = 0.6) {
		if (!this.isRunning) return;
		const amp = clamp(num(intensity, 0));
		if (amp <= 0.01) return;
		const hard = clamp(num(hardness, 0.6));
		if (!this._canVoice()) return;

		const ctx = this.ctx;
		const now = ctx.currentTime;
		const jitter = rand(0, 0.012);
		const t0 = now + jitter;

		// Hard steel rings long and bright; aluminium is a short dull thud.
		const ring = 0.10 + hard * 0.85;
		const dur = 0.18 + ring * 1.05;
		const v = this._voice(dur, amp);
		const g = v.gain;
		g.gain.cancelScheduledValues(now);
		g.gain.setValueAtTime(SILENCE, now);
		g.gain.linearRampToValueAtTime(safe(amp * 0.9), t0 + 0.004);
		g.gain.exponentialRampToValueAtTime(SILENCE, t0 + dur);

		// ---- (a) body thump: noise through a fast-decaying resonant lowpass ----
		const thumpSrc = this._noiseSource(true, true, rand(0.85, 1.1));
		const thumpFilter = v.track(ctx.createBiquadFilter());
		thumpFilter.type = 'lowpass';
		const thumpStart = rand(900, 1500) * (0.6 + hard * 0.8);
		thumpFilter.frequency.setValueAtTime(thumpStart, t0);
		thumpFilter.frequency.exponentialRampToValueAtTime(safe(70 + hard * 60), t0 + 0.16);
		thumpFilter.Q.setValueAtTime(7 + hard * 5, t0);
		const thumpGain = v.track(ctx.createGain());
		const thumpDur = 0.16 + (1 - hard) * 0.14;
		thumpGain.gain.setValueAtTime(SILENCE, t0);
		thumpGain.gain.linearRampToValueAtTime(safe(0.9), t0 + 0.003);
		thumpGain.gain.exponentialRampToValueAtTime(SILENCE, t0 + thumpDur);
		thumpSrc.connect(thumpFilter);
		thumpFilter.connect(thumpGain);
		thumpGain.connect(g);
		v.play(thumpSrc, t0, t0 + thumpDur + 0.02);

		// ---- (b) inharmonic clang partials ----
		const partialCount = 3 + Math.floor(rand(0, 2.99)); // 3..5
		const fundamental = (110 + hard * 340) * rand(0.9, 1.12);
		const ratios = [1, 1.71, 2.43, 3.16, 4.29];
		for (let i = 0; i < partialCount; i++) {
			const osc = ctx.createOscillator();
			osc.type = hard > 0.5 ? 'triangle' : 'sine';
			const f = fundamental * ratios[i] * rand(0.97, 1.03);
			osc.frequency.setValueAtTime(f, t0);
			// Metal detunes downward as it deforms.
			osc.frequency.exponentialRampToValueAtTime(safe(f * (0.96 - (1 - hard) * 0.05)), t0 + ring);
			osc.detune.setValueAtTime(rand(-14, 14), t0);

			const og = v.track(ctx.createGain());
			const pAmp = (0.55 / (i + 1)) * (0.35 + hard * 0.85);
			const pDur = ring * rand(0.55, 1.0) * (1 - i * 0.12);
			og.gain.setValueAtTime(SILENCE, t0);
			og.gain.linearRampToValueAtTime(safe(pAmp), t0 + 0.002 + i * 0.001);
			og.gain.exponentialRampToValueAtTime(SILENCE, t0 + Math.max(0.05, pDur));

			osc.connect(og);
			og.connect(g);
			v.play(osc, t0, t0 + Math.max(0.06, pDur) + 0.02);
		}

		// ---- (c) crushed-metal crackle ----
		const crackleSrc = this._noiseSource(false, true, rand(0.9, 1.3));
		const crackleBP = v.track(ctx.createBiquadFilter());
		crackleBP.type = 'bandpass';
		crackleBP.frequency.setValueAtTime(rand(2600, 5200) * (0.7 + hard * 0.6), t0);
		crackleBP.Q.setValueAtTime(2.4, t0);
		const crackleGain = v.track(ctx.createGain());
		const cDur = 0.05 + hard * 0.09;
		crackleGain.gain.setValueAtTime(SILENCE, t0);
		crackleGain.gain.linearRampToValueAtTime(safe(0.4 * (0.4 + hard * 0.8)), t0 + 0.002);
		crackleGain.gain.exponentialRampToValueAtTime(SILENCE, t0 + cDur);
		crackleSrc.connect(crackleBP);
		crackleBP.connect(crackleGain);
		crackleGain.connect(g);
		v.play(crackleSrc, t0, t0 + cDur + 0.02);
	}

	/**
	 * One-shot sheet-metal tear: descending filtered noise sweep + grain burst.
	 * @param {number} intensity 0..1
	 */
	tear(intensity) {
		if (!this.isRunning) return;
		const amp = clamp(num(intensity, 0));
		if (amp <= 0.01) return;
		if (!this._canVoice()) return;

		const ctx = this.ctx;
		const now = ctx.currentTime;
		const t0 = now + rand(0, 0.01);
		const sweepDur = rand(0.22, 0.38);
		const v = this._voice(sweepDur + 0.2, amp);
		const g = v.gain;
		g.gain.setValueAtTime(safe(amp), now);

		// ---- descending sweep ----
		const src = this._noiseSource(false, true, rand(0.95, 1.15));
		const bp = v.track(ctx.createBiquadFilter());
		bp.type = 'bandpass';
		const fStart = rand(4200, 6400);
		bp.frequency.setValueAtTime(fStart, t0);
		bp.frequency.exponentialRampToValueAtTime(safe(rand(420, 780)), t0 + sweepDur);
		bp.Q.setValueAtTime(3.2, t0);
		bp.Q.linearRampToValueAtTime(9, t0 + sweepDur);

		const shaper = v.track(ctx.createWaveShaper());
		shaper.curve = this._makeSaturationCurve(1.4, 1024);
		shaper.oversample = '4x';

		const sg = v.track(ctx.createGain());
		sg.gain.setValueAtTime(SILENCE, t0);
		sg.gain.linearRampToValueAtTime(safe(0.85), t0 + 0.012);
		sg.gain.exponentialRampToValueAtTime(safe(0.28), t0 + sweepDur * 0.7);
		sg.gain.exponentialRampToValueAtTime(SILENCE, t0 + sweepDur);

		src.connect(bp);
		bp.connect(shaper);
		shaper.connect(sg);
		sg.connect(g);
		v.play(src, t0, t0 + sweepDur + 0.03);

		// ---- granular click burst over ~120ms ----
		const grainBus = v.track(ctx.createGain());
		grainBus.gain.setValueAtTime(safe(0.7), t0);
		const grainHP = v.track(ctx.createBiquadFilter());
		grainHP.type = 'highpass';
		grainHP.frequency.setValueAtTime(1400, t0);
		grainBus.connect(grainHP);
		grainHP.connect(g);

		const grains = 12 + Math.floor(rand(0, 19)); // 12..30
		const span = 0.12;
		for (let i = 0; i < grains; i++) {
			const gt = t0 + (i / grains) * span + rand(0, span / grains);
			const gDur = rand(0.004, 0.016);
			const gsrc = this._noiseSource(false, true, rand(0.8, 1.6));
			const gg = v.track(ctx.createGain());
			const gAmp = rand(0.15, 0.6) * (1 - i / (grains * 1.6));
			gg.gain.setValueAtTime(SILENCE, gt);
			gg.gain.linearRampToValueAtTime(safe(gAmp), gt + 0.0012);
			gg.gain.exponentialRampToValueAtTime(SILENCE, gt + gDur);
			const gbp = v.track(ctx.createBiquadFilter());
			gbp.type = 'bandpass';
			gbp.frequency.setValueAtTime(rand(1800, 7200), gt);
			gbp.Q.setValueAtTime(rand(1.5, 6), gt);
			gsrc.connect(gbp);
			gbp.connect(gg);
			gg.connect(grainBus);
			try {
				gsrc.start(gt, gsrc._offset || 0);
				gsrc.stop(gt + gDur + 0.01);
			} catch { /* ignore */ }
			gsrc.onended = () => {
				try {
					gsrc.disconnect();
				} catch { /* ignore */ }
			};
		}
	}

	/**
	 * Tiny high-frequency crackle cluster from grinding sparks.
	 * @param {number} count number of ticks (clamped to 1..24)
	 */
	sparkBurst(count = 6) {
		if (!this.isRunning) return;
		const n = Math.max(1, Math.min(24, Math.floor(num(count, 6))));
		if (!this._canVoice()) return;

		const ctx = this.ctx;
		const now = ctx.currentTime;
		const span = 0.09 + n * 0.006;
		const v = this._voice(span + 0.08, 0.25);
		const g = v.gain;
		g.gain.setValueAtTime(safe(0.5), now);

		const hp = v.track(ctx.createBiquadFilter());
		hp.type = 'highpass';
		hp.frequency.setValueAtTime(3200, now);
		hp.connect(g);

		for (let i = 0; i < n; i++) {
			const t = now + rand(0, span);
			const d = rand(0.002, 0.008);
			const src = this._noiseSource(false, true, rand(1.0, 1.8));
			const bp = v.track(ctx.createBiquadFilter());
			bp.type = 'bandpass';
			bp.frequency.setValueAtTime(rand(4500, 11000), t);
			bp.Q.setValueAtTime(rand(6, 18), t);
			const eg = v.track(ctx.createGain());
			eg.gain.setValueAtTime(SILENCE, t);
			eg.gain.linearRampToValueAtTime(safe(rand(0.12, 0.42)), t + 0.0008);
			eg.gain.exponentialRampToValueAtTime(SILENCE, t + d);
			src.connect(bp);
			bp.connect(eg);
			eg.connect(hp);
			try {
				src.start(t, src._offset || 0);
				src.stop(t + d + 0.01);
			} catch { /* ignore */ }
			src.onended = () => {
				try {
					src.disconnect();
				} catch { /* ignore */ }
			};
		}
		// End the voice when the cluster is over.
		setTimeout(() => v.end(), (span + 0.12) * 1000);
	}

	/**
	 * Pneumatic hiss for the ram / feeder.
	 * @param {number} intensity 0..1
	 */
	hydraulicHiss(intensity = 0.6) {
		if (!this.isRunning) return;
		const amp = clamp(num(intensity, 0.6));
		if (amp <= 0.01) return;
		if (!this._canVoice()) return;

		const ctx = this.ctx;
		const now = ctx.currentTime;
		const t0 = now + rand(0, 0.008);
		const dur = 0.22 + amp * 0.55;
		const v = this._voice(dur + 0.1, amp * 0.6);
		const g = v.gain;
		g.gain.setValueAtTime(SILENCE, now);
		g.gain.linearRampToValueAtTime(safe(amp * 0.55), t0 + 0.03);
		g.gain.setTargetAtTime(safe(amp * 0.32), t0 + 0.05, 0.12);
		g.gain.exponentialRampToValueAtTime(SILENCE, t0 + dur);

		const src = this._noiseSource(false, true, rand(0.95, 1.1));
		const hp = v.track(ctx.createBiquadFilter());
		hp.type = 'highpass';
		hp.frequency.setValueAtTime(1100, t0);
		hp.frequency.exponentialRampToValueAtTime(safe(2600), t0 + dur);
		const bp = v.track(ctx.createBiquadFilter());
		bp.type = 'bandpass';
		bp.frequency.setValueAtTime(rand(3000, 4600), t0);
		bp.Q.setValueAtTime(1.1, t0);
		const lp = v.track(ctx.createBiquadFilter());
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime(9000, t0);
		lp.frequency.exponentialRampToValueAtTime(safe(4200), t0 + dur);

		src.connect(hp);
		hp.connect(bp);
		bp.connect(lp);
		lp.connect(g);
		v.play(src, t0, t0 + dur + 0.03);

		// Valve thunk at the end of travel.
		const osc = ctx.createOscillator();
		osc.type = 'sine';
		const tk = t0 + dur * 0.92;
		osc.frequency.setValueAtTime(rand(90, 150), tk);
		osc.frequency.exponentialRampToValueAtTime(safe(48), tk + 0.09);
		const og = v.track(ctx.createGain());
		og.gain.setValueAtTime(SILENCE, tk);
		og.gain.linearRampToValueAtTime(safe(amp * 0.5), tk + 0.004);
		og.gain.exponentialRampToValueAtTime(SILENCE, tk + 0.1);
		osc.connect(og);
		og.connect(g);
		v.play(osc, tk, tk + 0.12);
	}

	/** Contactor / relay snap used on power and reverse changes. */
	_relayClunk(amp = 1) {
		if (!this.isRunning) return;
		if (!this._canVoice()) return;
		const ctx = this.ctx;
		const now = ctx.currentTime;
		const t0 = now + 0.005;
		const dur = 0.13;
		const a = clamp(amp) * 0.55;
		const v = this._voice(dur + 0.05, a);
		const g = v.gain;
		g.gain.setValueAtTime(safe(a), now);

		const src = this._noiseSource(false, true, rand(0.9, 1.2));
		const bp = v.track(ctx.createBiquadFilter());
		bp.type = 'bandpass';
		bp.frequency.setValueAtTime(rand(220, 420), t0);
		bp.Q.setValueAtTime(4.5, t0);
		const ng = v.track(ctx.createGain());
		ng.gain.setValueAtTime(SILENCE, t0);
		ng.gain.linearRampToValueAtTime(safe(0.9), t0 + 0.002);
		ng.gain.exponentialRampToValueAtTime(SILENCE, t0 + 0.055);
		src.connect(bp);
		bp.connect(ng);
		ng.connect(g);
		v.play(src, t0, t0 + 0.08);

		const osc = ctx.createOscillator();
		osc.type = 'triangle';
		osc.frequency.setValueAtTime(rand(150, 230), t0);
		osc.frequency.exponentialRampToValueAtTime(safe(62), t0 + dur);
		const og = v.track(ctx.createGain());
		og.gain.setValueAtTime(SILENCE, t0);
		og.gain.linearRampToValueAtTime(safe(0.8), t0 + 0.003);
		og.gain.exponentialRampToValueAtTime(SILENCE, t0 + dur);
		osc.connect(og);
		og.connect(g);
		v.play(osc, t0, t0 + dur + 0.02);
	}

	// =====================================================================
	// Per-frame update
	// =====================================================================

	/**
	 * Per-frame smoothing of all continuous parameters, plus optional listener
	 * pose update from a THREE.Camera-like object exposing `matrixWorld`.
	 * @param {number} dt seconds since last frame
	 * @param {{matrixWorld?: {elements: ArrayLike<number>}}} [listenerCamera]
	 */
	update(dt, listenerCamera) {
		if (!this.isRunning) return;
		const ctx = this.ctx;
		const now = ctx.currentTime;
		const d = clamp(num(dt, 0.016), 0, 0.1);

		// ---------- RPM: ~1.4s spin-up, ~2.2s coast-down ----------
		// Rate is speed-dependent (inertia on the way up, windage on the way
		// down) but never reaches zero, so the target is always attained.
		const up = this._rpmTarget > this._rpm;
		if (this._rpmTarget !== this._rpm) {
			const rate = up
				? (1 / 1.4) * (1.35 - 0.7 * this._rpm)
				: (1 / 2.2) * (0.70 + 0.7 * this._rpm);
			const step = rate * d;
			this._rpm = up
				? Math.min(this._rpmTarget, this._rpm + step)
				: Math.max(this._rpmTarget, this._rpm - step);
		}
		this._rpm = clamp(this._rpm);

		// Governor overshoot decays back to nominal.
		this._rpmOvershoot *= Math.exp(-d * 3.2);
		if (Math.abs(this._rpmOvershoot) < 0.001) this._rpmOvershoot = 0;

		// ---------- load / conveyor / scrape smoothing ----------
		// Load bites fast, recovers slower.
		const loadRate = this._loadTarget > this._load ? 1 - Math.exp(-d * 12) : 1 - Math.exp(-d * 4.5);
		this._load += (this._loadTarget - this._load) * loadRate;
		this._load = clamp(this._load);

		this._conveyor += (this._conveyorTarget - this._conveyor) * (1 - Math.exp(-d * 3.5));

		// Scrape: fast attack, slow release so it never machine-guns.
		const scrapeRate = this._scrapeTarget > this._scrape ? 1 - Math.exp(-d * 22) : 1 - Math.exp(-d * 6);
		this._scrape += (this._scrapeTarget - this._scrape) * scrapeRate;
		this._scrape = clamp(this._scrape);
		// Decay the target so a frame without scrape() calls dies away.
		this._scrapeTarget *= Math.exp(-d * 9);

		const rpm = clamp(this._rpm + this._rpmOvershoot * this._rpm, 0, 1.25);
		const load = this._load;
		const rev = this._reverse ? 1 : 0;

		this._updateMotor(now, rpm, load, rev);
		this._updateGear(now, rpm, load, rev);
		this._updateMains(now, rpm, load);
		this._updateScrape(now, d);
		this._updateConveyor(now);
		this._updateListener(listenerCamera);
		this._reapVoices();
	}

	_updateMotor(now, rpm, load, rev) {
		const m = this._motor;
		const tc = 0.06;

		// 28Hz idle -> 55Hz full RPM; reverse runs a touch slower.
		let f = 28 + rpm * 27;
		f *= 1 - rev * 0.045;
		// Strain bends the fundamental DOWN by up to 18%.
		f *= 1 - load * 0.18;
		f = Math.max(12, f);
		m.base = f;

		for (const o of m.oscs) {
			o.osc.frequency.setTargetAtTime(safe(f * o.mult), now, tc);
		}

		// Cutoff opens with RPM and load; more resonance under strain.
		const cutoff = 120 + rpm * 260 + load * 900 + rev * 40;
		m.lp.frequency.setTargetAtTime(safe(cutoff), now, tc);
		m.lp.Q.setTargetAtTime(5.5 + load * 6 + rev * 1.5, now, tc);

		// Drive stage: growl harmonics grow with load.
		m.preDrive.gain.setTargetAtTime(safe(0.9 + load * 3.4), now, 0.08);
		m.postDrive.gain.setTargetAtTime(safe(0.72 / (1 + load * 1.1)), now, 0.08);
		m.body.frequency.setTargetAtTime(safe(f * 3.2), now, tc);
		m.body.gain.setTargetAtTime(4 + load * 7, now, tc);

		// Louder under load; silent when stopped.
		const level = rpm <= 0.001 ? SILENCE : 0.10 + rpm * 0.20 + load * 0.20;
		m.out.gain.setTargetAtTime(safe(level), now, 0.09);

		// Imbalance wobble tracks shaft speed.
		m.lfo.frequency.setTargetAtTime(safe(2.5 + rpm * 6), now, 0.15);
		m.lfoAmt.gain.setTargetAtTime(safe(0.02 + load * 0.07), now, 0.15);
	}

	_updateGear(now, rpm, load, rev) {
		const g = this._gear;
		const tc = 0.07;
		const f = this._motor.base;
		for (const o of g.oscs) {
			o.osc.frequency.setTargetAtTime(safe(f * o.mult), now, tc);
		}
		const centre = f * (rev ? 9.2 : 10.5);
		g.bp.frequency.setTargetAtTime(safe(centre), now, tc);
		g.bp2.frequency.setTargetAtTime(safe(centre * 1.9), now, tc);
		g.wobble.frequency.setTargetAtTime(safe(0.5 + rpm * 1.6), now, 0.2);
		g.wobbleAmt.gain.setTargetAtTime(safe(12 + rpm * 40 + load * 60), now, 0.2);

		// Whine is quiet at idle, screams at speed, ducks slightly under heavy load.
		const level = rpm <= 0.001 ? SILENCE : (0.012 + rpm * rpm * 0.06) * (1 - load * 0.35);
		g.out.gain.setTargetAtTime(safe(level), now, 0.1);
	}

	_updateMains(now, rpm, load) {
		const m = this._mains;
		const level = this._power || rpm > 0.02 ? 0.012 + load * 0.02 + rpm * 0.006 : SILENCE;
		m.out.gain.setTargetAtTime(safe(level), now, 0.25);
	}

	_updateScrape(now, dt) {
		const s = this._scrapeChain;
		const v = this._scrape;
		const tc = 0.04;

		// Randomly jitter the cascaded bandpass centres in 1.8k..7k.
		s.phase += dt;
		const bases = [2400, 3900, 5600];
		for (let i = 0; i < s.bands.length; i++) {
			const wob = Math.sin(s.phase * (3.1 + i * 1.7) + i) * 0.22 + rand(-0.16, 0.16);
			const f = clamp(bases[i] * (1 + wob), 1800, 7000);
			s.bands[i].frequency.setTargetAtTime(safe(f), now, 0.03);
			s.bands[i].Q.setTargetAtTime(4 + v * 7 + i, now, 0.08);
		}

		// The gliding shriek: high-Q peak wandering with intensity.
		const shriekF = clamp(2600 + v * 3200 + Math.sin(s.phase * 1.9) * 900 + rand(-260, 260), 1800, 7000);
		s.shriek.frequency.setTargetAtTime(safe(shriekF), now, 0.05);
		s.shriek.Q.setTargetAtTime(18 + v * 22, now, 0.1);
		s.shriek.gain.setTargetAtTime(8 + v * 16, now, 0.1);

		// Low grind bed follows the drum.
		s.grindBP.frequency.setTargetAtTime(safe(280 + v * 520), now, 0.08);
		s.grindGain.gain.setTargetAtTime(safe(0.2 + v * 0.7), now, 0.08);
		s.src.playbackRate.setTargetAtTime(safe(0.9 + v * 0.5), now, 0.12);

		const level = v <= 0.004 ? SILENCE : 0.02 + v * v * 0.42;
		s.out.gain.setTargetAtTime(safe(level), now, tc);
	}

	_updateConveyor(now) {
		const c = this._conveyorChain;
		if (!c) return;
		const s = this._conveyor;
		c.src.playbackRate.setTargetAtTime(safe(0.4 + s * 0.9), now, 0.2);
		c.lp.frequency.setTargetAtTime(safe(90 + s * 220), now, 0.15);
		c.thump.frequency.setTargetAtTime(safe(48 + s * 44), now, 0.15);
		c.squeakBP.Q.setTargetAtTime(16 + s * 22, now, 0.2);
		c.squeakGain.gain.setTargetAtTime(safe(0.005 + s * s * 0.09), now, 0.2);
		const level = s <= 0.005 ? SILENCE : 0.05 + s * 0.22;
		c.out.gain.setTargetAtTime(safe(level), now, 0.12);
	}

	_updateListener(cam) {
		const l = this.ctx && this.ctx.listener;
		if (!l || !cam || !cam.matrixWorld || !cam.matrixWorld.elements) return;
		const e = cam.matrixWorld.elements;
		if (!e || e.length < 16) return;

		const px = e[12], py = e[13], pz = e[14];
		// Three.js cameras look down -Z; up is +Y of the local frame.
		const fx = -e[8], fy = -e[9], fz = -e[10];
		const ux = e[4], uy = e[5], uz = e[6];
		if (!Number.isFinite(px) || !Number.isFinite(fx) || !Number.isFinite(ux)) return;

		const now = this.ctx.currentTime;
		if (l.positionX) {
			l.positionX.setTargetAtTime(px, now, 0.02);
			l.positionY.setTargetAtTime(py, now, 0.02);
			l.positionZ.setTargetAtTime(pz, now, 0.02);
			l.forwardX.setTargetAtTime(fx, now, 0.02);
			l.forwardY.setTargetAtTime(fy, now, 0.02);
			l.forwardZ.setTargetAtTime(fz, now, 0.02);
			l.upX.setTargetAtTime(ux, now, 0.02);
			l.upY.setTargetAtTime(uy, now, 0.02);
			l.upZ.setTargetAtTime(uz, now, 0.02);
		} else if (typeof l.setPosition === 'function') {
			l.setPosition(px, py, pz);
			l.setOrientation(fx, fy, fz, ux, uy, uz);
		}
	}

	// =====================================================================
	// Teardown
	// =====================================================================

	/** Stop everything, disconnect the graph and close the AudioContext. */
	dispose() {
		if (this._disposed) return;
		this._disposed = true;
		const ctx = this.ctx;
		if (!ctx) {
			this._started = false;
			return;
		}

		for (const v of this._voices.slice()) {
			try {
				v.stop();
			} catch { /* ignore */ }
		}
		this._voices.length = 0;

		const stopAll = (obj) => {
			if (!obj) return;
			for (const key of Object.keys(obj)) {
				const n = obj[key];
				if (!n) continue;
				if (Array.isArray(n)) {
					for (const item of n) {
						if (item && item.osc) stopAll({ o: item.osc });
						else stopAll({ o: item });
					}
					continue;
				}
				if (typeof n.stop === 'function') {
					try {
						n.stop();
					} catch { /* already stopped */ }
				}
				if (typeof n.disconnect === 'function') {
					try {
						n.disconnect();
					} catch { /* ignore */ }
				}
			}
		};

		stopAll(this._motor);
		stopAll(this._gear);
		stopAll(this._mains);
		stopAll(this._scrapeChain);
		stopAll(this._conveyorChain);

		for (const n of [this._revHP, this._revTone, this.convolver, this.reverbSend, this.reverbReturn, this.bus, this._preLimiter, this.compressor, this.master]) {
			try {
				if (n) n.disconnect();
			} catch { /* ignore */ }
		}

		this._motor = this._gear = this._mains = this._scrapeChain = this._conveyorChain = null;
		this._noiseWhite = this._noisePink = this._impulse = null;
		this._started = false;

		try {
			const closing = ctx.close();
			if (closing && typeof closing.catch === 'function') closing.catch(() => {});
		} catch { /* ignore */ }
		this.ctx = null;
	}
}
