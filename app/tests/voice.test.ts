// The voice-only page's pure logic: resampling, API base, mic gating, what gets spoken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicGate, Once, Resampler, EARCONS, deriveApiBase, speakable, splitSpeech, toPcm16 } from '../src/voice-audio.ts';

const s16 = (b: Uint8Array) => Array.from(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));

test('toPcm16 clamps and is little-endian', () => {
  assert.deepEqual(s16(toPcm16([0, 1, -1, 2, -2])), [0, 32767, -32768, 32767, -32768]);
});

test('resampler: 48 kHz to 16 kHz keeps a steady tone and the right length, across chunk boundaries', () => {
  const rs = new Resampler(48000);
  const total = 4800; // 100 ms
  const all = new Float32Array(total).fill(0.5);
  let got = 0;
  for (let i = 0; i < total; i += 441) {
    const out = s16(rs.process(all.subarray(i, Math.min(total, i + 441))));
    got += out.length;
    for (const v of out) assert.ok(Math.abs(v - 16384) < 2, String(v));
  }
  assert.ok(Math.abs(got - 1600) <= 2, `got ${got}`);
});

test('resampler: 44.1 kHz gives about 16000 samples per second; 16 kHz passes through', () => {
  const rs = new Resampler(44100);
  const out = rs.process(new Float32Array(44100));
  assert.ok(Math.abs(out.length / 2 - 16000) <= 2);
  const same = new Resampler(16000).process(Float32Array.from([0.25, -0.25]));
  assert.deepEqual(s16(same), [8192, -8192]);
});

test('API base is one level up from /web/voice.html, whatever the prefix', () => {
  assert.equal(deriveApiBase('https://example.test/web/voice.html'), 'https://example.test/');
  assert.equal(deriveApiBase('https://example.test/muse/web/voice.html?x=1#y'), 'https://example.test/muse/');
  assert.equal(deriveApiBase('http://localhost:5193/voice.html'), 'http://localhost:5193/');
});

test('mic gate: closed while speaking and for a tail after, open again once the loop wants the mic', () => {
  let now = 1000;
  const g = new MicGate(() => now, 500);
  assert.equal(g.accepts(), false); // the loop has not asked for the mic yet
  g.wanted = true;
  assert.equal(g.accepts(), true);
  g.setSpeaking(true);
  now += 5000;
  assert.equal(g.accepts(), false);
  g.setSpeaking(false);
  assert.equal(g.accepts(), false); // speaker tail
  now += 499;
  assert.equal(g.accepts(), false);
  now += 2;
  assert.equal(g.accepts(), true);
  g.mute(100); // an earcon
  assert.equal(g.accepts(), false);
  g.wanted = false;
  now += 1000;
  assert.equal(g.accepts(), false);
});

test('Once speaks each status a single time', () => {
  const o = new Once(2);
  assert.equal(o.first('a'), true);
  assert.equal(o.first('a'), false);
  o.first('b'); o.first('c');
  assert.equal(o.first('a'), true); // forgotten after the memory fills
});

test('speakable drops markdown, code and links; splitSpeech keeps pieces short', () => {
  assert.equal(speakable('# Title\n- **Bold** item and `code`\n```js\nx=1\n```\nSee [docs](https://a.test/x) or https://b.test/y'), 'Title Bold item and code See docs or a link');
  const parts = splitSpeech('One. Two! Three? ' + 'word '.repeat(100), 50);
  assert.deepEqual(parts.slice(0, 3), ['One.', 'Two!', 'Three?']);
  assert.ok(parts.every(p => p.length <= 50 && p.length > 0));
  assert.equal(splitSpeech('   ').length, 0);
});

test('earcons are distinct: five recipes, error has two low beeps, woke rises, stopped falls', () => {
  assert.equal(Object.keys(EARCONS).length, 5);
  assert.equal(EARCONS.error.length, 2);
  assert.ok(EARCONS.error.every(t => t.f0 < 250));
  assert.ok(EARCONS.woke[0].f1 > EARCONS.woke[0].f0);
  assert.ok(EARCONS.stopped[0].f1 < EARCONS.stopped[0].f0);
});
