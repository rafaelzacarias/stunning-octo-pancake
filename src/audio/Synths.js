/**
 * Small Web Audio synthesis helpers shared by {@link AudioEngine}.
 * All buffers are procedurally generated — no audio assets.
 */

/**
 * Create a looping white-noise buffer.
 * @param {BaseAudioContext} ctx
 * @param {number} [seconds=2]
 * @returns {AudioBuffer}
 */
export function createNoiseBuffer(ctx, seconds = 2) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Schedule a click-free exponential attack/decay envelope on a gain param.
 * Uses ramps only so nothing pops.
 * @param {AudioParam} param
 * @param {number} now context time
 * @param {number} peak
 * @param {number} attack seconds
 * @param {number} decay seconds
 * @param {number} [floor=0.0001]
 */
export function envAD(param, now, peak, attack, decay, floor = 0.0001) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(floor, now);
  param.linearRampToValueAtTime(peak, now + attack);
  param.exponentialRampToValueAtTime(floor, now + attack + decay);
}

/**
 * Smoothly move an AudioParam toward a target without clicks.
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} now
 * @param {number} [tau=0.05] time constant
 */
export function glide(param, value, now, tau = 0.05) {
  param.setTargetAtTime(value, now, tau);
}
