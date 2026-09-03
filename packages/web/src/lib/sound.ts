/**
 * Web Audio API synthesized cues for the SEAL console and Deepfake Attack Lab.
 * Zero external audio assets required -- everything is generated mathematically.
 */

let ctx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      ctx = new AudioCtx();
    }
  }
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => undefined);
  }
  return ctx;
}

/**
 * Play a synthesized telephone ring tone (standard dual-tone multi-frequency style).
 */
export function playPhoneRing() {
  const audio = getAudioContext();
  if (!audio) return;

  const now = audio.currentTime;
  const osc1 = audio.createOscillator();
  const osc2 = audio.createOscillator();
  const gain = audio.createGain();

  osc1.type = 'sine';
  osc2.type = 'sine';
  osc1.frequency.setValueAtTime(440, now);
  osc2.frequency.setValueAtTime(480, now);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
  gain.gain.setValueAtTime(0.12, now + 0.4);
  gain.gain.linearRampToValueAtTime(0.001, now + 0.45);

  gain.gain.setValueAtTime(0.001, now + 0.65);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.7);
  gain.gain.setValueAtTime(0.12, now + 1.1);
  gain.gain.linearRampToValueAtTime(0.0001, now + 1.15);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(audio.destination);

  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + 1.2);
  osc2.stop(now + 1.2);
}

/**
 * Play a crisp, low-pitched security alert tone when an attack is blocked.
 */
export function playAttackBlocked() {
  const audio = getAudioContext();
  if (!audio) return;

  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(110, now + 0.35);

  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

  osc.connect(gain);
  gain.connect(audio.destination);

  osc.start(now);
  osc.stop(now + 0.36);
}

/**
 * Play a high-assurance pleasant harmonic chime when quorum is met and payment settles.
 */
export function playSettlementChime() {
  const audio = getAudioContext();
  if (!audio) return;

  const freqs = [523.25, 659.25, 783.99, 1046.5];
  freqs.forEach((freq, idx) => {
    const now = audio.currentTime + idx * 0.09;
    const osc = audio.createOscillator();
    const gain = audio.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(gain);
    gain.connect(audio.destination);

    osc.start(now);
    osc.stop(now + 0.51);
  });
}
