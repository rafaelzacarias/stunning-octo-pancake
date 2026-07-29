/**
 * Procedural convolution reverb impulse responses.
 *
 * Generates a big-factory room impulse from filtered, exponentially decaying
 * noise with a little early-reflection structure — no audio files required.
 */

/**
 * Build a stereo impulse response buffer for a {@link ConvolverNode}.
 *
 * @param {BaseAudioContext} ctx
 * @param {object} [opts]
 * @param {number} [opts.duration=1.4] tail length in seconds
 * @param {number} [opts.decay=3.4] exponential decay steepness
 * @param {number} [opts.preDelay=0.012] gap before the first reflection (s)
 * @param {number} [opts.brightness=0.55] 0..1 high-frequency retention
 * @returns {AudioBuffer}
 */
export function createImpulseResponse(ctx, opts = {}) {
  const duration = opts.duration ?? 1.4;
  const decay = opts.decay ?? 3.4;
  const preDelay = opts.preDelay ?? 0.012;
  const brightness = opts.brightness ?? 0.55;

  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * duration));
  const buffer = ctx.createBuffer(2, length, rate);

  // A handful of early reflections (time in s, gain) for a sense of size.
  const reflections = [
    [0.017, 0.5], [0.029, 0.42], [0.041, 0.34],
    [0.063, 0.28], [0.089, 0.22], [0.121, 0.16]
  ];

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    // One-pole low-pass state for tail colour; darker channels feel roomier.
    let lp = 0;
    const cutoff = 0.12 + brightness * 0.55 - ch * 0.05;
    const preSamples = Math.floor(preDelay * rate);

    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay);
      let s = (Math.random() * 2 - 1) * env;
      lp += (s - lp) * cutoff;
      s = lp;

      if (i >= preSamples) {
        for (let r = 0; r < reflections.length; r++) {
          const rt = reflections[r][0] * (ch ? 1.06 : 0.94);
          const idx = preSamples + Math.floor(rt * rate);
          if (i === idx) s += reflections[r][1] * (ch ? -1 : 1);
        }
      }
      data[i] = s;
    }
  }
  return buffer;
}
