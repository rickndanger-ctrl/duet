// Voice activity detection on the glasses' 16 kHz s16le mono PCM.
// Energy-based with an adaptive noise floor: cheap enough to run on every audio chunk the glasses send.
// The floor keeps learning the room while you talk (the quietest moment of the last 2 s is the room, not you),
// so a fan, traffic or a TV can't hold the mic open. The end of speech is also judged against your own voice:
// once you stop, background noise well under your level counts as quiet.

export const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
export const FRAME_MS = 20;

export interface VadOptions {
  /** Silence that ends an utterance. */
  endSilenceMs: number;
  /** Shortest speech kept (coughs and taps are dropped). */
  minSpeechMs: number;
  /** Longest utterance; it is cut and sent at this length. */
  maxSpeechMs: number;
  /** Audio kept from before the speech started, so the first syllable isn't lost. */
  prerollMs: number;
  /** 1 (deaf) .. 10 (hears whispers). Sets how far above the noise floor speech must be. */
  sensitivity: number;
}

export const DEFAULT_VAD: VadOptions = { endSilenceMs: 800, minSpeechMs: 160, maxSpeechMs: 30_000, prerollMs: 300, sensitivity: 6 };

/** Frames of the room kept to find its quietest moment (2 s). */
const ROOM_FRAMES = 100;
/** Sound must last this long to count as voice (a knock, clink or key press is shorter). */
const VOICE_FRAMES = 4;
/** Once you're talking, sound this far under your voice is background (about -12 dB). */
const UNDER_VOICE = 0.25;

export interface VadEvents {
  onSpeechStart?: () => void;
  /** A finished utterance: the whole PCM (with preroll) and how long the speech part was. */
  onUtterance?: (pcm: Uint8Array, speechMs: number) => void;
  /** Speech that was too short to keep. */
  onDiscard?: () => void;
  /** Level of each frame, 0..1, for a meter. */
  onLevel?: (level: number, speaking: boolean) => void;
}

function rms(frame: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) {
    let s = frame[i] | (frame[i + 1] << 8);
    if (s & 0x8000) s -= 0x10000;
    sum += s * s;
  }
  return Math.sqrt(sum / (frame.length / 2));
}

export class Vad {
  private carry = new Uint8Array(0);
  private floor = 0;
  private room: number[] = [];
  private voice = 0;
  private speaking = false;
  private loudRun = 0;
  private voicedRun = 0;
  private quietMs = 0;
  private speechMs = 0;
  private preroll: Uint8Array[] = [];
  private utterance: Uint8Array[] = [];
  options: VadOptions;

  constructor(private readonly events: VadEvents, options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD, ...options };
  }

  get isSpeaking(): boolean { return this.speaking; }

  /** Speech must be this many times the noise floor (sensitivity 10 → 1.3x, 6 → 3x, 1 → 5x). */
  private factor(): number { return 5.5 - 0.42 * Math.min(10, Math.max(1, this.options.sensitivity)); }
  private minLevel(): number { return 60 + (10 - this.options.sensitivity) * 60; }

  reset(): void {
    this.carry = new Uint8Array(0);
    this.speaking = false; this.loudRun = 0; this.voicedRun = 0; this.quietMs = 0; this.speechMs = 0; this.voice = 0;
    this.preroll = []; this.utterance = [];
  }

  /** The mic was just opened: forget the old room, learn the new one from the first frames. */
  restart(): void { this.reset(); this.floor = 0; this.room = []; }

  /** The current noise floor (for logs and tests). */
  get noiseFloor(): number { return this.floor; }

  /** Ends the current utterance now (a tap means "I'm done"). Returns whether one was sent. */
  flush(): boolean {
    if (!this.speaking) return false;
    this.finish(true);
    return true;
  }

  push(chunk: Uint8Array): void {
    let data = chunk;
    if (this.carry.length) { data = new Uint8Array(this.carry.length + chunk.length); data.set(this.carry); data.set(chunk, this.carry.length); }
    let at = 0;
    for (; at + FRAME_BYTES <= data.length; at += FRAME_BYTES) this.frame(data.slice(at, at + FRAME_BYTES));
    this.carry = data.slice(at);
  }

  private frame(frame: Uint8Array): void {
    const level = rms(frame);
    this.learnRoom(level);
    const on = Math.max(this.floor * this.factor(), this.minLevel());
    this.events.onLevel?.(Math.min(1, level / 6000), this.speaking);
    if (!this.speaking) {
      this.preroll.push(frame);
      const keep = Math.ceil(this.options.prerollMs / FRAME_MS);
      if (this.preroll.length > keep) this.preroll.shift();
      this.loudRun = level > on ? this.loudRun + 1 : 0;
      if (this.loudRun >= VOICE_FRAMES) {
        this.speaking = true;
        this.utterance = [...this.preroll];
        this.preroll = [];
        this.speechMs = this.loudRun * FRAME_MS;
        this.quietMs = 0;
        this.voicedRun = this.loudRun;
        this.voice = level;
        this.events.onSpeechStart?.();
      }
      return;
    }
    this.utterance.push(frame);
    const off = Math.max(on * 0.6, this.voice * UNDER_VOICE);
    this.voicedRun = level > off ? this.voicedRun + 1 : 0;
    // Your voice: rises with sustained loud sound (not a single knock), fades slowly, so background talk after you stop stays "under" it.
    if (this.voicedRun >= VOICE_FRAMES && level > this.voice) this.voice = this.voice * 0.7 + level * 0.3;
    else this.voice *= 0.997;
    if (this.voicedRun > 0) this.speechMs += FRAME_MS;
    if (this.voicedRun >= VOICE_FRAMES) this.quietMs = 0; else this.quietMs += FRAME_MS;
    if (this.quietMs >= this.options.endSilenceMs || this.speechMs + this.quietMs >= this.options.maxSpeechMs) this.finish(false);
  }

  /** Noise floor: follows the room down fast and up slowly, and never sits under the quietest frame of the last 2 s. */
  private learnRoom(level: number): void {
    this.room.push(level);
    if (this.room.length > ROOM_FRAMES) this.room.shift();
    if (this.floor === 0) { this.floor = Math.max(20, level); return; }
    if (this.room.length <= 5) { this.floor = Math.max(20, Math.min(...this.room)); return; } // just opened: the first 100 ms is the room
    if (!this.speaking) this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * 0.98 + level * 0.02;
    if (this.room.length >= ROOM_FRAMES / 2) this.floor = Math.max(this.floor, Math.min(...this.room));
    this.floor = Math.max(20, this.floor);
  }

  private finish(forced: boolean): void {
    const frames = this.utterance;
    const speechMs = this.speechMs;
    this.speaking = false; this.loudRun = 0; this.voicedRun = 0; this.quietMs = 0; this.speechMs = 0; this.voice = 0; this.utterance = []; this.preroll = [];
    if (speechMs < this.options.minSpeechMs && !forced) { this.events.onDiscard?.(); return; }
    const out = new Uint8Array(frames.length * FRAME_BYTES);
    frames.forEach((f, i) => out.set(f, i * FRAME_BYTES));
    this.events.onUtterance?.(out, speechMs);
  }
}
