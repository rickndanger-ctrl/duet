// Hey Muse (the Muse build): its wake word, measured on real Whisper transcripts, and its buddy. Duet's own wake word
// and buddy are covered in core.test.ts and mascot.test.ts and must not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HEY_DUET, HEY_MUSE, matchMuseWake, isMusePause, matchWake, isPause } from '../src/wake.ts';
import { animation, sprite, gutter, W, H } from '../src/mascot.ts';
import { MUSE_GUY_ART } from '../src/museguy.ts';
import { statusLine, type Phase } from '../src/screen.ts';

const measured = readFileSync(new URL('./fixtures/hey-muse-whisper.txt', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('|')[1]);

test('every "Hey Muse" Whisper wrote for 10 voices wakes Hey Muse, with the question kept', () => {
  assert.equal(measured.length, 50);
  // 49 of 50. The one miss on purpose: the bare name heard as "News, …" (no "hey"); waking on "News" would let the TV wake Muse.
  const missed = measured.filter(t => matchMuseWake(t) === null);
  assert.deepEqual(missed, ['News, set a timer for five minutes.']);
  assert.equal(matchMuseWake('Hey Mews!'), '');
  assert.equal(matchMuseWake('Hey Mews, what time is it?'), 'what time is it?');
  assert.equal(matchMuseWake('Hey, Muse, tell me a joke.'), 'tell me a joke.');
  assert.equal(matchMuseWake('Musay, set a timer for 5 minutes.'), 'set a timer for 5 minutes.');
  assert.equal(matchMuseWake('Muse. Set a timer for 5 minutes.'), 'Set a timer for 5 minutes.');
  assert.equal(matchMuseWake('hey muse, what is on my calendar?'), 'what is on my calendar?');
});

test('likely mishearings after "hey" wake; the loose ones alone do not', () => {
  for (const t of ['Hey Muze.', 'Hey News, what is up?', 'Hey Moose!', 'Okay Muse', 'Hi, Muse.', 'Hey music.']) assert.notEqual(matchMuseWake(t), null, t);
  for (const t of ['News at ten.', 'The news today is bad.', 'I love music.', 'Must be nice.', 'That was amusing.', 'Hey Duet, what time is it?', 'Moose are big.', 'Museum hours?'])
    assert.equal(matchMuseWake(t), null, t);
});

test('"pause" and "thanks Muse" stop Hey Muse from listening', () => {
  for (const t of ['Pause.', 'Thanks Muse.', 'Hey Muse, pause.', 'Muse, stop listening.', "That's all."]) assert.ok(isMusePause(t), t);
  assert.ok(!isMusePause('Pause the music in the kitchen and turn off the lights please'));
});

test('Duet keeps "Hey Duet" exactly as before', () => {
  assert.equal(HEY_DUET.match, matchWake);
  assert.equal(HEY_DUET.isPause, isPause);
  assert.equal(HEY_DUET.label, 'Hey Duet');
  assert.equal(statusLine('armed'), 'PAUSED · "Hey Duet"');
  assert.equal(statusLine('armed', '', HEY_MUSE.label), 'PAUSED · "Hey Muse"');
});

test("the Muse guy draws every pose, differently from Claude, and has its own gutter mark", () => {
  const phases: Phase[] = ['asleep', 'armed', 'listening', 'hearing', 'transcribing', 'thinking', 'working', 'answering', 'your-turn', 'confirm', 'error'];
  for (const p of phases) for (const pose of animation(p).poses) {
    const g = sprite(pose, MUSE_GUY_ART);
    assert.equal(g.length, W * H);
    assert.ok(g.some(v => v > 0), pose);
    assert.ok(g.some((v, i) => v !== sprite(pose)[i]), `${pose} differs from Claude`);
  }
  const same = (a: Parameters<typeof sprite>[0], b: Parameters<typeof sprite>[0]) => sprite(a, MUSE_GUY_ART).every((v, i) => v === sprite(b, MUSE_GUY_ART)[i]);
  for (const [a, b] of [['idle', 'sleep'], ['talk1', 'talk2'], ['work1', 'work2'], ['think1', 'think3'], ['idle', 'happy'], ['idle', 'oops']] as const) assert.ok(!same(a, b), `${a} vs ${b}`);
  // The body stays left of the effects (x 76..95).
  const idle = sprite('idle', MUSE_GUY_ART);
  for (let y = 0; y < H; y++) for (let x = 76; x < W; x++) assert.equal(idle[y * W + x], 0);
  const mark = gutter([null, 'claude', null, null], MUSE_GUY_ART);
  assert.ok(mark.some(v => v > 0));
  assert.ok(mark.some((v, i) => v !== gutter([null, 'claude', null, null])[i]));
});

// ---- Hey Muse's conversation timing (Duet keeps its defaults; core.test.ts covers those) ----------------------------
import { Duet } from '../src/duet.ts';
import type { ChatEvent } from '../src/api.ts';

function pcm(ms: number, amp: number): Uint8Array {
  const n = Math.round(16 * ms), out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { const s = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000) + (Math.random() - 0.5) * 80); const v = s < 0 ? s + 0x10000 : s; out[2 * i] = v & 0xff; out[2 * i + 1] = (v >> 8) & 0xff; }
  return out;
}
const feed = (push: (c: Uint8Array) => void, data: Uint8Array) => { for (let at = 0; at < data.length; at += 640) push(data.slice(at, at + 640)); };
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

function museHarness(transcripts: string[], answer = 'Here you go.') {
  const asked: string[] = [];
  const duet = new Duet({
    show: () => {}, mic: async () => true, context: () => ({}), log: () => {}, confirm: async () => {},
    transcribe: async () => transcripts.shift() ?? '',
    chat: async (_c, text, _x, onEvent: (e: ChatEvent) => void) => { asked.push(text); onEvent({ t: 'delta', text: answer }); onEvent({ t: 'done' }); },
    wake: HEY_MUSE, talkEndSilenceMs: 1600, shortRepliesOnlyIfAsked: true,
  }, { wakeWord: true, followUpMs: 5000 });
  const speak = (ms: number, silence: number) => { feed(c => duet.audio(c), pcm(300, 0)); feed(c => duet.audio(c), pcm(ms, 4000)); feed(c => duet.audio(c), pcm(silence, 0)); };
  return { duet, asked, speak };
}

test('Hey Muse waits 1.6 s of silence before sending your reply (a 1.2 s pause to find a word stays one message)', async () => {
  const h = museHarness(['Hey Muse, what pies do I have?', 'Give me my chocolate custard pie recipe']);
  h.duet.start();
  h.speak(900, 1700); await settle(80);
  assert.equal(h.duet.phase, 'your-turn');
  feed(c => h.duet.audio(c), pcm(300, 0));
  feed(c => h.duet.audio(c), pcm(900, 4000)); // "give me my..."
  feed(c => h.duet.audio(c), pcm(1200, 0)); // finding the word
  await settle(80);
  assert.equal(h.asked.length, 1, 'not sent during a 1.2 s pause');
  feed(c => h.duet.audio(c), pcm(800, 4000)); // "...chocolate custard pie recipe"
  feed(c => h.duet.audio(c), pcm(3600, 0)); // by now you've talked 2.5 s+, so Duet's "room to think" pause (3.5 s) applies
  await settle(80);
  assert.deepEqual(h.asked, ['what pies do I have?', 'Give me my chocolate custard pie recipe']);
});

test('Hey Muse: a lone "Yeah." after a plain answer is a nod, not a question; after a question it is sent', async () => {
  const h = museHarness(['Hey Muse, what time is it?', 'Yeah.', 'Okay.']);
  h.duet.start();
  h.speak(900, 1700); await settle(80);
  assert.equal(h.asked.length, 1);
  h.speak(700, 1700); await settle(80);
  h.speak(700, 1700); await settle(80);
  assert.equal(h.asked.length, 1, '"Yeah." and "Okay." were not sent');
  const q = museHarness(['Hey Muse, find my pie recipe', 'Yeah.'], 'I found two. Want the chocolate one?');
  q.duet.start();
  q.speak(900, 1700); await settle(80);
  q.speak(700, 1700); await settle(80);
  assert.deepEqual(q.asked, ['find my pie recipe', 'Yeah.']);
});

test('Hey Muse: ending like a phone call stops listening; questions about goodbyes do not', () => {
  for (const t of ['Alright, Muse, you can end the phone call if you want.', 'Okay, talk to you later.', 'Bye Muse.', 'Thanks, goodbye.', "That's all for now.", 'Good night, Muse.', 'Hang up.'])
    assert.ok(isMusePause(t), t);
  for (const t of ['How do you say goodbye in French?', 'Should I end the call with Sam at three?', 'Remind me to call Sam later today about the pies.', 'What time does the conversation end?'])
    assert.ok(!isMusePause(t), t);
});
