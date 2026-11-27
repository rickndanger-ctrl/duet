import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vad } from '../src/vad.ts';
import { matchWake, isRealSpeech } from '../src/wake.ts';
import { frame, statusLine, wrap, COLS, BODY_LINES, glassesSafe } from '../src/screen.ts';
import { Duet } from '../src/duet.ts';
import type { ChatEvent, ChatMessage } from '../src/api.ts';

/** PCM of `ms` milliseconds: a 220 Hz tone at `amp`, plus a little noise. */
function pcm(ms: number, amp: number): Uint8Array {
  const n = Math.round(16 * ms);
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000) + (Math.random() - 0.5) * 80);
    const v = s < 0 ? s + 0x10000 : s;
    out[2 * i] = v & 0xff; out[2 * i + 1] = (v >> 8) & 0xff;
  }
  return out;
}
/** Feed in uneven chunks, like the glasses do. */
function feed(push: (c: Uint8Array) => void, data: Uint8Array): void {
  for (let at = 0; at < data.length;) { const len = 300 + Math.floor(Math.random() * 900); push(data.slice(at, at + len)); at += len; }
}

test('vad finds one utterance between silences', () => {
  const got: number[] = [];
  let starts = 0;
  const vad = new Vad({ onSpeechStart: () => starts++, onUtterance: (_p, ms) => got.push(ms) });
  feed(c => vad.push(c), pcm(1000, 0));
  feed(c => vad.push(c), pcm(1200, 4000));
  feed(c => vad.push(c), pcm(1200, 0));
  assert.equal(starts, 1);
  assert.equal(got.length, 1);
  assert.ok(got[0] >= 1000 && got[0] <= 1300, `speech ${got[0]} ms`);
});

test('vad drops a click and ignores steady room noise', () => {
  let utterances = 0, discards = 0;
  const vad = new Vad({ onUtterance: () => utterances++, onDiscard: () => discards++ });
  feed(c => vad.push(c), pcm(800, 300)); // fan noise
  feed(c => vad.push(c), pcm(100, 6000)); // a tap on the frame
  feed(c => vad.push(c), pcm(3000, 300));
  assert.equal(utterances, 0);
  assert.ok(discards <= 1);
});

test('vad flush sends speech at once', () => {
  let utterances = 0;
  const vad = new Vad({ onUtterance: () => utterances++ });
  feed(c => vad.push(c), pcm(500, 0));
  feed(c => vad.push(c), pcm(600, 4000));
  assert.equal(vad.flush(), true);
  assert.equal(utterances, 1);
});

test('wake phrase variants', () => {
  assert.equal(matchWake('Hey Duet.'), '');
  assert.equal(matchWake('Hey, Duet, what time is it?'), 'what time is it?');
  assert.equal(matchWake('hey do it what is the weather'), 'what is the weather');
  assert.equal(matchWake('Hey due it. Tell me a joke'), 'Tell me a joke');
  assert.equal(matchWake('Duet, set a timer'), 'set a timer');
  assert.equal(matchWake('Hi Dewitt'), '');
  assert.equal(matchWake('Okay Duet'), '');
  assert.equal(matchWake('do it now'), null);
  assert.equal(matchWake('I love the duet they played'), null);
  assert.equal(matchWake('hey there'), null);
  assert.equal(matchWake('duets are fun'), null);
});

test('whisper phantoms are not speech', () => {
  for (const t of ['Thank you.', 'you', '...', 'Thanks for watching!', '[Music]', '']) assert.equal(isRealSpeech(t), false, t);
  for (const t of ['What time is it?', 'yes', 'no thanks']) assert.equal(isRealSpeech(t), true, t);
});

test('layout: wrap, status line, follow and scroll', () => {
  const lines = wrap('word '.repeat(100));
  assert.ok(lines.every(l => l.length <= COLS));
  assert.ok(statusLine('your-turn').startsWith('DUET'));
  const f = frame('S', lines, null);
  assert.equal(f.scroll, f.maxScroll);
  assert.ok(!f.text.endsWith('▼'));
  const top = frame('S', lines, 0);
  assert.ok(top.text.endsWith('▼'));
  assert.equal(top.text.split('\n').length, 2 + BODY_LINES);
  assert.equal(glassesSafe('**Bold** 😀 “hi” — ok'), 'Bold  "hi" - ok');
});

// ---- the loop, with a fake server ------------------------------------------------

function harness(transcripts: string[], opts: { wakeWord?: boolean } = {}) {
  const shown: string[] = [];
  const asked: ChatMessage[][] = [];
  const micStates: boolean[] = [];
  const log: string[] = [];
  const duet = new Duet({
    show: t => shown.push(t),
    mic: async on => { micStates.push(on); return true; },
    transcribe: async () => transcripts.shift() ?? '',
    chat: async (messages, _ctx, onEvent: (e: ChatEvent) => void) => {
      asked.push(messages);
      for (const w of ['Sure, ', 'here ', 'you go.']) { await new Promise(r => setTimeout(r, 5)); onEvent({ t: 'delta', text: w }); }
      onEvent({ t: 'done' });
    },
    context: () => ({}),
    log: l => log.push(l),
  }, { wakeWord: opts.wakeWord ?? true, followUpMs: 400 });
  const speak = (ms = 900) => { feed(c => duet.audio(c), pcm(300, 0)); feed(c => duet.audio(c), pcm(ms, 4000)); feed(c => duet.audio(c), pcm(1000, 0)); };
  return { duet, shown, asked, micStates, log, speak };
}
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

test('hey duet + question in one breath, then a reply with no tap, then sleep', async () => {
  const h = harness(['Hey Duet, what is a good pie for Thanksgiving?', 'And what goes with it?']);
  h.duet.start();
  assert.equal(h.duet.phase, 'armed');
  assert.equal(h.micStates.at(-1), true, 'mic open while armed');
  h.speak();
  await settle(120);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].at(-1)!.content, 'what is a good pie for Thanksgiving?');
  assert.equal(h.duet.phase, 'your-turn');
  assert.ok(h.shown.at(-1)!.includes('here you go.'));
  assert.ok(h.shown.at(-1)!.includes('your turn'));
  // Reply without touching anything.
  h.speak();
  await settle(120);
  assert.equal(h.asked.length, 2);
  assert.deepEqual(h.asked[1].map(m => m.role), ['user', 'assistant', 'user']);
  // Then say nothing: back to waiting for the wake word.
  await settle(500);
  assert.equal(h.duet.phase, 'armed');
});

test('hey duet alone wakes and waits for the question', async () => {
  const h = harness(['Hey Duet.', 'Tell me a joke']);
  h.duet.start();
  h.speak(600);
  await settle(40);
  assert.ok(['listening', 'your-turn'].includes(h.duet.phase), h.duet.phase);
  assert.ok(h.shown.at(-1)!.includes('Yes?'));
  h.speak();
  await settle(120);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0][0].content, 'Tell me a joke');
});

test('other talk does not wake it', async () => {
  const h = harness(['so I told him about the pie shop', 'yeah totally']);
  h.duet.start();
  h.speak(); await settle(40);
  h.speak(); await settle(40);
  assert.equal(h.duet.phase, 'armed');
  assert.equal(h.asked.length, 0);
});

test('tap to talk with the wake word off; mic is off while asleep', async () => {
  const h = harness(['What is the capital of Peru?'], { wakeWord: false });
  h.duet.start();
  assert.equal(h.duet.phase, 'asleep');
  assert.equal(h.micStates.at(-1), false);
  h.duet.gesture('tap');
  await settle(5);
  assert.equal(h.micStates.at(-1), true);
  h.speak();
  await settle(120);
  assert.equal(h.asked.length, 1);
  h.duet.gesture('double');
  await settle(5);
  assert.equal(h.duet.phase, 'asleep');
  assert.equal(h.micStates.at(-1), false);
});

test('leaving the front closes the mic; coming back reopens it for the wake word', async () => {
  const h = harness([]);
  h.duet.start();
  await settle(5);
  h.duet.foreground(false);
  await settle(5);
  assert.equal(h.micStates.at(-1), false);
  h.duet.foreground(true);
  await settle(5);
  assert.equal(h.micStates.at(-1), true);
});
