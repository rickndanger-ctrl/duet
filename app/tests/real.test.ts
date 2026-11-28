// Regression tests on real recorded voices (tests/fixtures), with RNNoise on, set up exactly like Duet listening for
// your reply. They lock in what worked on the glasses on 2026-11-27: a loud talker in the background (a YouTube video)
// doesn't hold the mic open after you stop, a pause to find your words doesn't cut you off, a door squeak isn't sent
// to speech-to-text, and short replies are still heard. If one of these fails, the change broke conversation on G2.
//
// Background loudness is measured against your voice at the glasses mic. The G2 mics sit next to your mouth, so a
// loud video across the room arrives 30 dB or more under you; then Duet ignores it completely (Rick's test). At 20-25
// dB under, the talker may open the mic first, but your message is still sent a few seconds after YOU stop. Known
// limit (not tested): someone 12-15 dB under you, i.e. talking right beside you, can hold the mic open until you tap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vad, SAMPLE_RATE as SR } from '../src/vad.ts';
import { VoiceScore } from '../src/denoise.ts';

const clip = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/${name}.pcm`, import.meta.url));
  return Float32Array.from(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));
};
/** Loudness of the voiced part of a clip. */
const voiceLevel = (a: Float32Array) => { let s = 0, n = 0; for (const v of a) if (Math.abs(v) > 500) { s += v * v; n++; } return Math.sqrt(s / Math.max(1, n)); };
let seed = 11;
const hiss = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff * 2 - 1) * 30; };

/** Bounds of the actual speech in a clip (first/last 20 ms frame with sound), in seconds. */
function speechSpan(a: Float32Array): [number, number] {
  let first = -1, last = -1;
  for (let i = 0; i + 320 <= a.length; i += 320) { let s = 0; for (let k = i; k < i + 320; k++) s += a[k] * a[k]; if (Math.sqrt(s / 320) > 300) { if (first < 0) first = i; last = i + 320; } }
  return [first / SR, last / SR];
}

interface Run { utterances: { start: number; end: number }[] }
/**
 * Plays `you` at `at` seconds over `background` (looped, `dbUnder` quieter than your voice), through the VAD set up
 * like Duet waiting for your reply (talk mode). Returns when each utterance started and ended (seconds).
 */
async function listen(you: Float32Array | null, opts: { at?: number; background?: Float32Array; dbUnder?: number; seconds: number; voice?: boolean; wake?: boolean }): Promise<Run> {
  const n = Math.round(opts.seconds * SR), at = Math.round((opts.at ?? 1) * SR);
  const bg = opts.background, k = bg ? (voiceLevel(you ?? bg) / voiceLevel(bg)) * 10 ** (-(opts.dbUnder ?? 15) / 20) : 0;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = (you && i >= at && i < at + you.length ? you[i - at] : 0) + (bg ? bg[i % bg.length] * k : 0) + hiss();
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  const utterances: Run['utterances'] = [];
  let t = 0, started = 0;
  const vad = new Vad({ onSpeechStart: () => { started = t; }, onUtterance: () => utterances.push({ start: started, end: t }) },
    opts.wake ? { endSilenceMs: 500 } : { endSilenceMs: 1000, longAfterMs: 2500, longEndSilenceMs: 3500 });
  if (opts.voice !== false) {
    const vs = await VoiceScore.load();
    assert.ok(vs, 'RNNoise loads');
    vad.voiceScore = f => vs!.score(f);
  }
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i += 1280) { t = (i + 1280) / 2 / SR; vad.push(bytes.slice(i, i + 1280)); }
  return { utterances };
}

test('real voice: a question is taken whole and sent about a second after you stop', async () => {
  const you = clip('next'), [s, e] = speechSpan(you);
  const r = await listen(you, { at: 1, seconds: 6 });
  assert.equal(r.utterances.length, 1, JSON.stringify(r));
  const u = r.utterances[0];
  assert.ok(u.start <= 1 + s + 0.15, `starts with your first word (${u.start.toFixed(2)})`);
  const after = u.end - (1 + e);
  assert.ok(after > 0.8 && after < 1.6, `sent ${after.toFixed(2)} s after you stop`);
});

test('real voice: a loud talker in the background (YouTube) does not hold the mic open after you stop', async () => {
  const you = clip('next'), [, e] = speechSpan(you);
  for (const dbUnder of [20, 25, 30, 35]) {
    const r = await listen(you, { at: 4, background: clip('talker'), dbUnder, seconds: 16 });
    const mine = r.utterances.filter(u => u.end > 4 + e);
    assert.ok(mine.length >= 1, `${dbUnder} dB: heard you`);
    const after = mine[0].end - (4 + e);
    assert.ok(after < 4.5, `${dbUnder} dB under you: sent ${after.toFixed(2)} s after you stop, not when he stops`);
    if (dbUnder >= 30) {
      assert.equal(r.utterances.length, 1, `${dbUnder} dB: only you`);
      assert.ok(r.utterances[0].start > 3.8 && after < 1.6, `${dbUnder} dB: he is ignored; sent ${after.toFixed(2)} s after you stop`);
    }
  }
});

test('real voice: a 2.6 s pause to find your words, with a talker in the background, stays one message', async () => {
  const you = clip('think'), [s, e] = speechSpan(you);
  const r = await listen(you, { at: 1, background: clip('talker'), dbUnder: 30, seconds: 16 });
  const covering = r.utterances.filter(u => u.start <= 1 + s + 0.3 && u.end >= 1 + e);
  assert.equal(covering.length, 1, `both halves in one message: ${JSON.stringify(r.utterances.map(u => [u.start.toFixed(1), u.end.toFixed(1)]))}`);
  assert.ok(covering[0].end - (1 + e) < 5, 'and it is sent once you stop');
});

test('real voice: a short "Sure." is heard, quiet or with a talker in the background', async () => {
  for (const background of [undefined, clip('talker')]) {
    const r = await listen(clip('sure'), { at: 1, background, dbUnder: 30, seconds: 5 });
    assert.ok(r.utterances.some(u => u.start < 2 && u.end > 1.2), background ? 'over a talker' : 'quiet');
  }
});

test('RNNoise: door squeaks are not sent to speech-to-text (and without it they would be)', async () => {
  const squeaks = new Float32Array(SR * 9);
  const sq = clip('squeak');
  for (const at of [1, 4, 7]) squeaks.set(sq.subarray(0, Math.min(sq.length, squeaks.length - at * SR)), at * SR);
  const withScore = await listen(squeaks, { at: 0, seconds: 9, wake: true });
  assert.equal(withScore.utterances.length, 0, 'none sent with the voice score');
  const loudnessOnly = await listen(squeaks, { at: 0, seconds: 9, wake: true, voice: false });
  assert.ok(loudnessOnly.utterances.length > 0, 'the test sound is loud enough to matter');
});

test('real voice: "Hey Duet, what\'s my next meeting?" is one utterance while waiting for the wake word', async () => {
  const r = await listen(clip('next'), { at: 1, seconds: 5, wake: true });
  assert.equal(r.utterances.length, 1, JSON.stringify(r));
});
