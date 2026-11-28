// Pure helpers for the voice-only page (voice.html): resampling the phone mic to the loop's 16 kHz s16le mono PCM,
// the mic gate (no mic audio into the loop while the phone speaks), earcon recipes, what gets spoken, and the API base.
// Nothing here touches the DOM or WebAudio, so it is all unit-tested.

export const LOOP_RATE = 16000;

/** Streaming resampler: Float32 mono at any rate -> s16le bytes at 16 kHz. Box-averaged when downsampling. */
export class Resampler {
  private carry = new Float32Array(0);
  private pos = 0;
  private readonly step: number;
  constructor(readonly inRate: number, readonly outRate = LOOP_RATE) { this.step = inRate / outRate; }

  process(input: Float32Array): Uint8Array {
    const x = new Float32Array(this.carry.length + input.length);
    x.set(this.carry); x.set(input, this.carry.length);
    const out: number[] = [];
    if (this.step === 1) { for (const v of input) out.push(v); this.carry = new Float32Array(0); this.pos = 0; return toPcm16(out); }
    const taps = Math.max(1, Math.round(this.step));
    let pos = this.pos;
    while (pos + this.step + 1 <= x.length) {
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const p = pos + (this.step * (j + 0.5)) / taps;
        const i = Math.floor(p);
        const f = p - i;
        sum += x[i] * (1 - f) + x[i + 1] * f;
      }
      out.push(sum / taps);
      pos += this.step;
    }
    const i = Math.floor(pos);
    this.carry = x.slice(i);
    this.pos = pos - i;
    return toPcm16(out);
  }
}

export function toPcm16(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return out;
}

/** The API root for a page served at `<base>/web/voice.html`: `<base>/`. Anywhere else (dev server): the page's origin. */
export function deriveApiBase(href: string): string {
  const u = new URL(href);
  if (/\/web\/[^/]*$/.test(u.pathname)) return new URL('../', u).href;
  return `${u.origin}/`;
}

/** Decides whether mic audio may reach the loop: never while speaking (or an earcon plays), nor shortly after, nor when the loop wants the mic off. */
export class MicGate {
  wanted = false;
  private speaking = false;
  private until = 0;
  constructor(private readonly now: () => number = () => Date.now(), private readonly tailMs = 500) {}
  setSpeaking(on: boolean): void { this.speaking = on; if (!on) this.until = Math.max(this.until, this.now() + this.tailMs); }
  /** Mute for a moment (an earcon is playing). */
  mute(ms: number): void { this.until = Math.max(this.until, this.now() + ms); }
  get isSpeaking(): boolean { return this.speaking; }
  accepts(): boolean { return this.wanted && !this.speaking && this.now() >= this.until; }
}

/** Remembers the last few keys: `first(key)` is true only the first time (a status or error is spoken once). */
export class Once {
  private keys: string[] = [];
  constructor(private readonly max = 20) {}
  first(key: string): boolean {
    if (this.keys.includes(key)) return false;
    this.keys.push(key);
    if (this.keys.length > this.max) this.keys.shift();
    return true;
  }
}

export interface Tone { t: number; dur: number; f0: number; f1: number; type: OscillatorType; gain: number }
export type Earcon = 'woke' | 'sent' | 'tick' | 'stopped' | 'error';
/** Short, distinct sounds: rising chirp (listening), click (sent), soft tick (waiting), falling tone (paused), low double-beep (error). */
export const EARCONS: Record<Earcon, Tone[]> = {
  woke: [{ t: 0, dur: 0.16, f0: 520, f1: 1040, type: 'sine', gain: 0.25 }],
  sent: [{ t: 0, dur: 0.025, f0: 2200, f1: 1400, type: 'square', gain: 0.12 }],
  tick: [{ t: 0, dur: 0.04, f0: 1000, f1: 1000, type: 'sine', gain: 0.07 }],
  stopped: [{ t: 0, dur: 0.28, f0: 760, f1: 300, type: 'sine', gain: 0.22 }],
  error: [{ t: 0, dur: 0.12, f0: 170, f1: 170, type: 'triangle', gain: 0.35 }, { t: 0.2, dur: 0.12, f0: 170, f1: 170, type: 'triangle', gain: 0.35 }],
};
export const earconMs = (e: Earcon): number => Math.max(...EARCONS[e].map(t => t.t + t.dur)) * 1000;

/** Text for the synthetic voice: no markdown marks, links or code. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentence-sized pieces (iOS cuts off long utterances), each at most `max` characters. */
export function splitSpeech(text: string, max = 200): string[] {
  const out: string[] = [];
  for (const sentence of text.match(/[^.!?\n]+[.!?]*\s*/g) ?? []) {
    let s = sentence.trim();
    while (s.length > max) {
      let cut = s.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/** A guess at how long speaking takes, for a watchdog in case the browser never says it has finished. */
export const speechTimeoutMs = (text: string): number => 4000 + text.length * 120;
