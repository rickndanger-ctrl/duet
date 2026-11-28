// RNNoise (Xiph's recurrent-network noise suppressor, Jitsi's WebAssembly build, Apache-2.0) as a voice detector.
// For every 20 ms of glasses audio it says how likely it is that a person is talking (0..1). The VAD uses that to
// ignore loud sounds that aren't a voice (a fan, music, clatter, a dog) so they don't open the mic or go to
// speech-to-text. Whisper still gets the original audio: it copes with noise better than with denoised audio.
//
// RNNoise works on 10 ms frames at 48 kHz; the glasses send 16 kHz, so each sample is upsampled 3x (linear: plenty
// for detection). This is the RNNoise 0.2 model (the build with the wasm inlined, ~1.9 MB): its voice score tells a
// squeaky door or a dog from a person far better than the 0.1 model (measured on Duet's clips, 2026-11-27). It is
// loaded in its own chunk after startup, so Duet opens as fast as before.

const RN_FRAME = 480; // samples per RNNoise frame (10 ms at 48 kHz)

interface RnModule {
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, out: number, input: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

export class VoiceScore {
  private readonly buf: number;
  private readonly state: number;
  private last = 0; // the previous 16 kHz sample, to upsample across frame edges
  private readonly up = new Float32Array(RN_FRAME * 2);

  private constructor(private readonly m: RnModule) {
    this.state = m._rnnoise_create(0);
    this.buf = m._malloc(RN_FRAME * 4);
  }

  /** Loads RNNoise; null if it can't run here (then the VAD works on loudness alone, as before). */
  static async load(): Promise<VoiceScore | null> {
    try {
      const { default: create } = await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js');
      return new VoiceScore(create() as RnModule);
    } catch {
      return null;
    }
  }

  /** How likely 20 ms of 16 kHz audio (320 samples, int16 scale) is a voice: the louder of its two RNNoise frames. */
  score(frame: Int16Array): number {
    const up = this.up;
    for (let i = 0; i < frame.length && 3 * i + 2 < up.length; i++) {
      const a = this.last, b = frame[i];
      up[3 * i] = a + (b - a) / 3; up[3 * i + 1] = a + 2 * (b - a) / 3; up[3 * i + 2] = b;
      this.last = b;
    }
    let best = 0;
    for (let k = 0; k < 2; k++) {
      this.m.HEAPF32.set(up.subarray(k * RN_FRAME, (k + 1) * RN_FRAME), this.buf >> 2);
      best = Math.max(best, this.m._rnnoise_process_frame(this.state, this.buf, this.buf));
    }
    return best;
  }

  destroy(): void {
    this.m._free(this.buf);
    this.m._rnnoise_destroy(this.state);
  }
}
