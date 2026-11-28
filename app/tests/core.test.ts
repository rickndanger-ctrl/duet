import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vad } from '../src/vad.ts';
import { matchWake, isRealSpeech, yesNo, isPause, confirmReply } from '../src/wake.ts';
import { body, frame, statusLine, turnBody, wrap, COLS, BODY_COLS, BODY_LINES, INDENT, STATUS_MAX, glassesSafe } from '../src/screen.ts';
import { Duet } from '../src/duet.ts';
import type { ChatEvent } from '../src/api.ts';

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
  // Real Groq Whisper output for macOS voices saying the phrases (2026-11-27).
  assert.equal(matchWake('Hey, duet.'), '');
  assert.equal(matchWake('Duet. Set a timer for 10 minutes.'), 'Set a timer for 10 minutes.');
  assert.equal(matchWake('I told him about the pie shop yesterday.'), null);
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
  assert.ok(statusLine('your-turn').startsWith('TALK NOW'));
  for (const p of ['transcribing', 'thinking', 'answering'] as const) assert.ok(statusLine(p).startsWith('WAIT'), p);
  assert.equal(statusLine('confirm', 'Move'), 'Move?  YES / NO');
  for (const p of ['asleep', 'armed', 'listening', 'hearing', 'transcribing', 'thinking', 'answering', 'your-turn', 'confirm'] as const)
    assert.ok(statusLine(p, 'checking your calendar').length <= STATUS_MAX, `${p} ends before the buddy`);
  const b = body([{ who: null, text: 'word '.repeat(100) }]);
  const f = frame('S', b, null);
  assert.equal(f.scroll, f.maxScroll);
  assert.ok(!f.text.endsWith('▼'));
  const top = frame('S', b, 0);
  assert.ok(top.text.endsWith('▼'));
  assert.equal(top.text.split('\n').length, 2 + BODY_LINES);
  assert.equal(glassesSafe('**Bold** 😀 “hi” — ok'), 'Bold  "hi" - ok');
  assert.equal(glassesSafe('        * item'), '        - item', 'bullets keep the gutter indent');
});

test('layout: your whole message is shown, and the gutter marks who speaks', () => {
  const you = 'And then sometimes when I talk longer and quicker it gets cut off and I cannot see the whole message on the lens.';
  const t = turnBody({ you, duet: 'Got it. Long messages now show in full.' }, '');
  const f = frame('S', t, null);
  const rows = f.text.split('\n').slice(2);
  assert.equal(rows.filter(r => r.trim()).map(r => r.trim()).join(' ').includes(you), true, 'all of it');
  assert.equal(f.marks[0], 'me');
  const claudeRow = rows.findIndex(r => r.includes('Got it.'));
  assert.equal(f.marks[claudeRow], 'claude');
  assert.equal(f.marks.filter(Boolean).length, 2);
  assert.ok(rows.filter(r => r).every(r => r.startsWith(' '.repeat(INDENT))), 'every line leaves the gutter free');
  assert.ok(rows.every(r => r.trim().length <= BODY_COLS + 3));
});

// ---- the loop, with a fake server ------------------------------------------------

function harness(transcripts: string[], opts: { wakeWord?: boolean; thinkMs?: number } = {}) {
  const shown: string[] = [];
  const asked: { conversation: string; text: string }[] = [];
  const confirms: { id: string; ok: boolean }[] = [];
  let confirmWaiter: ((ok: boolean) => void) | null = null;
  const micStates: boolean[] = [];
  const log: string[] = [];
  const duet = new Duet({
    show: t => shown.push(t),
    mic: async on => { micStates.push(on); return true; },
    transcribe: async () => transcripts.shift() ?? '',
    chat: async (conversation, text, _ctx, onEvent: (e: ChatEvent) => void) => {
      asked.push({ conversation, text });
      if (/email/i.test(text)) {
        onEvent({ t: 'status', text: 'checking your mail' });
        const ok = await new Promise<boolean>(r => { confirmWaiter = r; onEvent({ t: 'confirm', id: 'c1', verb: 'Send', prompt: 'Reply to Sam\n"See you at noon."' }); });
        onEvent({ t: 'delta', text: ok ? 'Sent.' : 'Not sent.' });
        onEvent({ t: 'done' });
        return;
      }
      if (opts.thinkMs) await new Promise(r => setTimeout(r, opts.thinkMs));
      for (const w of ['Sure, ', 'here ', 'you go.']) { await new Promise(r => setTimeout(r, 5)); onEvent({ t: 'delta', text: w }); }
      onEvent({ t: 'done' });
    },
    confirm: async (id, ok) => { confirms.push({ id, ok }); confirmWaiter?.(ok); },
    context: () => ({}),
    log: l => log.push(l),
  }, { wakeWord: opts.wakeWord ?? true, followUpMs: 400 });
  const speak = (ms = 900) => { feed(c => duet.audio(c), pcm(300, 0)); feed(c => duet.audio(c), pcm(ms, 4000)); feed(c => duet.audio(c), pcm(1000, 0)); };
  return { duet, shown, asked, confirms, micStates, log, speak };
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
  assert.equal(h.asked[0].text, 'what is a good pie for Thanksgiving?');
  assert.equal(h.duet.phase, 'your-turn');
  assert.ok(h.shown.at(-1)!.includes('here you go.'));
  assert.ok(h.shown.at(-1)!.includes('your turn'));
  // Reply without touching anything.
  h.speak();
  await settle(120);
  assert.equal(h.asked.length, 2);
  assert.equal(h.asked[1].conversation, h.asked[0].conversation, 'same conversation');
  assert.equal(h.asked[1].text, 'And what goes with it?');
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
  assert.equal(h.asked[0].text, 'Tell me a joke');
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

test('spoken yes / no', () => {
  for (const t of ['Yes.', 'Yeah, send it.', 'Send it', 'Go ahead.', 'Sure!']) assert.equal(yesNo(t), true, t);
  for (const t of ['No.', 'Nope', "Don't send it", 'Cancel.', 'Wait, change it']) assert.equal(yesNo(t), false, t);
  for (const t of ['Okay.', 'Thank you.', 'you', 'what time is it', '']) assert.equal(yesNo(t), null, t);
});

test('an action waits on the lens and a spoken "yes" sends it', async () => {
  const h = harness(['Reply to the email from Sam', 'Yes, send it.']);
  h.duet.gesture('tap');
  h.speak();
  await settle(60);
  assert.equal(h.duet.phase, 'confirm');
  const lens = h.shown.at(-1)!;
  assert.ok(lens.includes('Send?') && lens.includes('See you at noon.') && lens.includes('yes'), lens);
  h.speak(500);
  await settle(80);
  assert.deepEqual(h.confirms, [{ id: 'c1', ok: true }]);
  assert.equal(h.duet.phase, 'your-turn');
  assert.ok(h.shown.at(-1)!.includes('Sent.'));
});

test('double tap says no; noise and "okay" do not answer', async () => {
  const h = harness(['Reply to the email from Sam', 'Okay.', 'thank you']);
  h.duet.gesture('tap');
  h.speak();
  await settle(60);
  h.speak(400); await settle(40);
  h.speak(400); await settle(40);
  assert.equal(h.duet.phase, 'confirm');
  assert.equal(h.confirms.length, 0);
  h.duet.gesture('double');
  await settle(30);
  assert.deepEqual(h.confirms, [{ id: 'c1', ok: false }]);
  assert.ok(h.shown.at(-1)!.includes('Not sent.'));
});

test('pause phrases stop listening; questions do not', () => {
  for (const t of ['Pause.', 'pause', 'Stop listening', "That's all.", 'Thanks Duet', 'Okay, pause', 'Hey Duet, pause']) assert.equal(isPause(t), true, t);
  for (const t of ['Pause the music in the kitchen please now', 'What time is it?', 'Stopwatch for five minutes', 'yes']) assert.equal(isPause(t), false, t);
});

test('a yes or no with a change in it redrafts instead of sending', () => {
  for (const t of ['Yes.', 'Yeah, send it.', 'Sure, go ahead.', 'Yes please']) assert.deepEqual(confirmReply(t), { ok: true }, t);
  for (const t of ['No.', 'No thanks.', "No, don't send it.", 'Nope, not now', 'Cancel it.']) assert.deepEqual(confirmReply(t), { ok: false }, t);
  for (const t of ['No, say 20 minutes instead.', 'Yes, but make it Friday.', 'Wait, change the time to five.', 'No, send it to Sam instead'])
    assert.deepEqual(confirmReply(t), { ok: false, change: t }, t);
  assert.deepEqual(confirmReply('what time is it'), { ok: false, change: 'what time is it' }, 'a sentence goes to Claude instead of waiting');
  assert.equal(confirmReply('okay'), null);
  assert.equal(confirmReply('hmm'), null);
});

test('"Okay." after an answer is sent when clearly spoken, but not from a blip of noise', async () => {
  const h = harness(['Hey Duet, what time is it?', 'Okay.', 'Okay.']);
  h.duet.start();
  h.speak(); await settle(120);
  h.speak(200); await settle(80); // a blip Whisper heard as "Okay."
  assert.equal(h.asked.length, 1);
  h.speak(700); await settle(120);
  assert.equal(h.asked.length, 2);
  assert.equal(h.asked[1].text, 'Okay.');
});

test('"Hey Duet" while already awake just says Yes? and the name is not sent to Claude', async () => {
  const h = harness(['Hey Duet, tell me a joke', 'Hey Duet.', 'Hey Duet, another one']);
  h.duet.start();
  h.speak(); await settle(120);
  h.speak(600); await settle(60);
  assert.equal(h.asked.length, 1);
  assert.ok(h.shown.at(-1)!.includes('Yes?'));
  h.speak(); await settle(120);
  assert.equal(h.asked[1].text, 'another one');
});

test('a pause mid-sentence does not split the message: the rest joins it before Claude answers', async () => {
  const h = harness(['Hey Duet, remind me that the hackathon', 'ends tomorrow at noon'], { thinkMs: 300 });
  h.duet.start();
  h.speak(); await settle(40);
  assert.equal(h.duet.phase, 'thinking');
  h.speak(); await settle(450);
  assert.equal(h.asked.at(-1)!.text, 'remind me that the hackathon ends tomorrow at noon');
  assert.equal(h.duet.phase, 'your-turn');
});

test('a sentence while a draft waits goes to Claude instead of being ignored', async () => {
  const h = harness(['Reply to the email from Sam', 'so there were a lot of bugs today']);
  h.duet.gesture('tap');
  h.speak(); await settle(60);
  assert.equal(h.duet.phase, 'confirm');
  h.speak(); await settle(80);
  assert.deepEqual(h.confirms, [{ id: 'c1', ok: false }], 'not sent, passed to Claude as what you said');
});

test('while you talk, your line already shows on the lens', async () => {
  const h = harness(['Hey Duet, what time is it?']);
  h.duet.start();
  feed(c => h.duet.audio(c), pcm(300, 0));
  feed(c => h.duet.audio(c), pcm(600, 4000)); // still talking
  await settle(5);
  assert.equal(h.duet.phase, 'armed', 'asleep: only the wake word');
  h.duet.gesture('tap'); await settle(5);
  feed(c => h.duet.audio(c), pcm(300, 0));
  feed(c => h.duet.audio(c), pcm(600, 4000));
  await settle(5);
  assert.equal(h.duet.phase, 'hearing');
  assert.ok(h.shown.at(-1)!.trimEnd().endsWith('…'), JSON.stringify(h.shown.at(-1)));
});
