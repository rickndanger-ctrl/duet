import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vad, SAMPLE_RATE as SR } from '../src/vad.ts';
import { clock, statusLine } from '../src/screen.ts';

// Synthetic sound: a "sentence" of syllables (voiced tone bursts with short gaps), and room noises around it.
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

function sentence(sec: number, amp = 6000): Float32Array {
  const a = new Float32Array(Math.round(sec * SR));
  let t = 0;
  while (t < a.length) {
    const syl = Math.round((0.12 + Math.abs(rnd()) * 0.12) * SR);
    for (let i = 0; i < syl && t + i < a.length; i++) {
      const env = Math.sin(Math.PI * i / syl);
      const x = (t + i) / SR;
      a[t + i] = amp * env * (0.6 * Math.sin(2 * Math.PI * 140 * x) + 0.3 * Math.sin(2 * Math.PI * 280 * x) + 0.1 * rnd());
    }
    t += syl + Math.round((Math.abs(rnd()) < 0.7 ? 0.05 : 0.15) * SR);
  }
  return a;
}
const noise = (n: number, rms: number) => Float32Array.from({ length: n }, () => rnd() * rms * Math.sqrt(3));

/** Plays `before` s of room, the sentence, then 10 s of room; returns when each utterance ended, relative to the end of speech. */
function play(sec: number, room: (n: number, at: number) => Float32Array, before = 1.5) {
  const speech = sentence(sec);
  const lead = Math.round(before * SR), n = lead + speech.length + 10 * SR;
  const bg = room(n, lead);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(bg[i] + (i >= lead && i < lead + speech.length ? speech[i - lead] : 0))));
  const ends: number[] = [];
  let t = 0;
  const vad = new Vad({ onUtterance: () => ends.push(t / SR - before - sec) });
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i += 1280) { t = Math.min(n, (i + 1280) / 2); vad.push(bytes.slice(i, i + 1280)); }
  return ends;
}

const closesSoon = (ends: number[], what: string) => {
  assert.equal(ends.length, 1, `${what}: one utterance, not cut in pieces or repeated (${ends.map(e => e.toFixed(1))})`);
  assert.ok(ends[0] > 0 && ends[0] < 1.5, `${what}: the mic closes soon after you stop (${ends[0].toFixed(1)} s)`);
};

test('the mic closes soon after you stop, in a quiet room', () => closesSoon(play(2.5, n => noise(n, 40)), 'quiet'));

test('steady noise (a fan, traffic) does not hold the mic open', () => closesSoon(play(2.5, n => noise(n, 500)), 'fan'));

test('noise that starts while you talk does not hold the mic open', () => {
  closesSoon(play(2.5, (n, at) => { const a = noise(n, 1000); for (let i = 0; i < at + SR; i++) a[i] *= 0.03; return a; }), 'onset');
});

test('knocks and clinks after you stop do not hold the mic open', () => {
  closesSoon(play(2.5, n => {
    const a = noise(n, 60);
    for (let t = SR; t < n; t += Math.round((0.15 + Math.abs(rnd()) * 0.25) * SR)) for (let i = 0; i < 400 && t + i < n; i++) a[t + i] += rnd() * 9000 * Math.exp(-i / 100);
    return a;
  }), 'clatter');
});

test('other voices well under yours do not hold the mic open', () => {
  closesSoon(play(2.5, (n, at) => {
    const a = noise(n, 40);
    const other = sentence(20, 1100); // someone across the room, ~15 dB under, never stopping
    for (let i = Math.round(at * 0.5); i < n; i++) a[i] += other[i % other.length];
    return a;
  }), 'voices');
});

test('a long sentence is not cut at a pause between words', () => closesSoon(play(6, n => noise(n, 300)), 'long'));

test('the corner clock shows the date and time, and fits beside the buddy', () => {
  const c = clock(new Date(2026, 10, 27, 15, 42));
  assert.match(c, /\b(3:42|15:42)\b/);
  assert.match(c, /27/);
  assert.match(c, /Fri/);
  assert.ok(c.length <= 24, c);
  assert.equal(statusLine('armed'), 'PAUSED · "Hey Duet"');
});
