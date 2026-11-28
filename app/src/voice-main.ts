// Hey Muse, voice only: an iPhone in Safari with Ray-Ban Meta glasses as a plain Bluetooth headset. No display, so
// everything is sound: earcons for the loop's states, the answer spoken with speechSynthesis. The conversation loop is
// the same Duet class the G2 app uses; only its inputs and outputs are different (phone mic in, ears out).
import * as api from './api';
import { MUSE } from './brand';
import { Duet } from './duet';
import { VoiceScore } from './denoise';
import type { Phase, Turn } from './screen';
import { EARCONS, MicGate, Once, Resampler, deriveApiBase, earconMs, speakable, speechTimeoutMs, splitSpeech, type Earcon } from './voice-audio';

const TOKEN_KEY = 'duetmuse.voice.token';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const server: api.ServerConfig = { url: deriveApiBase(location.href), token: '', brain: MUSE.assistant, spoken: true };
try { server.token = localStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* private mode */ }
$<HTMLInputElement>('token').value = server.token;
$('token').addEventListener('change', () => {
  server.token = $<HTMLInputElement>('token').value.trim();
  try { localStorage.setItem(TOKEN_KEY, server.token); } catch { /* ignore */ }
});

const STATE: Record<Phase, string> = {
  asleep: 'Paused. Tap to talk', armed: `Say "${MUSE.wake.label}"`, listening: 'Listening', hearing: 'Hearing you', transcribing: 'Got it',
  thinking: 'Thinking', working: 'Working', answering: 'Answering', 'your-turn': 'Your turn', confirm: 'Say yes or no', error: 'Error',
};
const say = (id: string, text: string) => { $(id).textContent = text; };
const log = (line: string) => console.log('[muse-voice]', line);

// ---- sound out ---------------------------------------------------------------------------------------------------
let ctx: AudioContext | null = null;
const gate = new MicGate();

function earcon(name: Earcon): void {
  if (!ctx) return;
  gate.mute(earconMs(name) + 150);
  const t0 = ctx.currentTime + 0.01;
  for (const tone of EARCONS[name]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.setValueAtTime(tone.f0, t0 + tone.t);
    osc.frequency.linearRampToValueAtTime(tone.f1, t0 + tone.t + tone.dur);
    g.gain.setValueAtTime(0.0001, t0 + tone.t);
    g.gain.linearRampToValueAtTime(tone.gain, t0 + tone.t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.t + tone.dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0 + tone.t);
    osc.stop(t0 + tone.t + tone.dur + 0.02);
  }
}

class Speaker {
  private utterances: SpeechSynthesisUtterance[] = []; // kept referenced: Safari drops "end" events of collected ones
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private done: (() => void) | null = null;
  get busy(): boolean { return this.done !== null; }

  /** Speak `text`; `onEnd` runs when it finishes or is cancelled. */
  speak(text: string, onEnd: () => void): void {
    this.cancel();
    const clean = speakable(text);
    const parts = splitSpeech(clean);
    if (!parts.length) return onEnd();
    this.done = onEnd;
    this.utterances = parts.map((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = navigator.language || 'en-US';
      if (i === parts.length - 1) { u.onend = () => this.finish(); u.onerror = () => this.finish(); }
      return u;
    });
    this.watchdog = setTimeout(() => this.finish(), speechTimeoutMs(clean));
    for (const u of this.utterances) speechSynthesis.speak(u);
  }

  cancel(): void {
    if (!this.done) return;
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    this.finish();
  }

  private finish(): void {
    clearTimeout(this.watchdog);
    const done = this.done;
    this.done = null;
    this.utterances = [];
    done?.();
  }
}
const speaker = new Speaker();
const spokenOnce = new Once();
let spokenTurn: Turn | null = null;

function speak(text: string): void {
  gate.setSpeaking(true);
  speaker.speak(text, () => {
    gate.setSpeaking(false);
    duet.vad.reset(); // drop whatever half-heard sound the speakers left in it
    duet.rearmFollowUp();
  });
}

// ---- the loop --------------------------------------------------------------------------------------------------------
let pendingConfirm: { id: string; prompt: string } | null = null;
let lastError = '';
let prev: Phase | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;

const asleepish = (p?: Phase) => p === 'asleep' || p === 'armed';
const waiting = (p: Phase) => p === 'thinking' || p === 'working' || p === 'answering';

function onPhase(p: Phase): void {
  const before = prev;
  prev = p;
  say('state', STATE[p]);
  // Soft tick every ~2 s while Muse is thinking.
  if (waiting(p) && !ticker) ticker = setInterval(() => earcon('tick'), 2000);
  if (!waiting(p)) { clearInterval(ticker); ticker = undefined; }

  if ((p === 'listening' || p === 'your-turn') && asleepish(before)) earcon('woke');
  else if (p === 'thinking' && before !== 'thinking') earcon('sent');
  else if (asleepish(p) && before !== undefined && !asleepish(before)) { speaker.cancel(); earcon('stopped'); }
  else if (p === 'error') {
    earcon('error');
    const msg = lastError || 'Something went wrong.';
    if (spokenOnce.first(`error:${msg}:${Date.now() >> 12}`)) setTimeout(() => speak(`Sorry. ${msg}`), 500);
  } else if (p === 'confirm' && pendingConfirm && spokenOnce.first(`confirm:${pendingConfirm.id}`)) {
    speak(`Approval needed. ${pendingConfirm.prompt} Say yes or no.`);
  } else if (p === 'your-turn' && duet.turn && duet.turn !== spokenTurn && duet.turn.duet.trim()) {
    spokenTurn = duet.turn;
    speak(duet.turn.duet);
  }
}

const duet: Duet = new Duet({
  show: () => { /* no lens */ },
  mic: async on => { gate.wanted = on; return true; },
  transcribe: async (pcm, mode, signal) => {
    try { return await api.transcribe(server, pcm, mode, signal); } catch (e) { lastError = (e as Error).message; throw e; }
  },
  chat: async (conversation, text, context, onEvent, signal) => {
    let approvalSaid = false;
    try {
      await api.chat(server, conversation, text, context, e => {
        if (e.t === 'confirm') pendingConfirm = { id: e.id, prompt: e.prompt };
        if (e.t === 'error') lastError = e.message;
        // Muse waits for an approval in its own window: say so once, the ticking alone doesn't tell you.
        if (e.t === 'status' && /approval/i.test(e.text) && !approvalSaid) { approvalSaid = true; speak(e.text); }
        onEvent(e);
      }, signal);
    } catch (e) { lastError = (e as Error).message; throw e; }
  },
  confirm: (id, ok, change) => api.confirm(server, id, ok, change),
  context: () => ({ time: new Date().toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', timeZoneName: 'short' }), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  log,
  wake: MUSE.wake,
  ...MUSE.loop,
  onTurn: turn => { say('q', turn.you || '-'); say('a', turn.duet || '...'); },
  onPhase,
});

// ---- mic in: phone mic -> 16 kHz s16le mono PCM ----------------------------------------------------------------------
const WORKLET = `class P extends AudioWorkletProcessor { process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } }
registerProcessor('pcm-tap', P);`;

async function openMic(audio: AudioContext): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const source = audio.createMediaStreamSource(stream);
  const rs = new Resampler(audio.sampleRate);
  const feed = (samples: Float32Array) => { const pcm = rs.process(samples); if (pcm.length && gate.accepts()) duet.audio(pcm); };
  const silent = audio.createGain();
  silent.gain.value = 0; // keeps the capture node pulled by the graph without playing the mic
  silent.connect(audio.destination);
  if (audio.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await audio.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(audio, 'pcm-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = e => feed(e.data as Float32Array);
    source.connect(node).connect(silent);
  } else {
    const node = audio.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = e => feed(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(node).connect(silent);
  }
}

// ---- iOS: start, wake lock, taps ---------------------------------------------------------------------------------------
let wakeLock: WakeLockSentinel | null = null;
async function keepAwake(): Promise<void> {
  try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock?.request('screen') ?? null; } catch { /* not allowed (e.g. low power) */ }
}
let started = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !started) return;
  void keepAwake();
  void ctx?.resume();
});

$('start').addEventListener('click', async () => {
  if (started) return;
  server.token = $<HTMLInputElement>('token').value.trim();
  try { localStorage.setItem(TOKEN_KEY, server.token); } catch { /* ignore */ }
  if (!server.token) { say('msg', 'Enter the token first.'); $('token').focus(); return; }
  say('msg', '');
  try {
    // Everything iOS gates on a tap happens here, inside the tap.
    ctx = new AudioContext();
    await ctx.resume();
    const unlock = new SpeechSynthesisUtterance('.');
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
    void keepAwake();
    await openMic(ctx);
  } catch (e) {
    say('msg', `Could not start: ${(e as Error).message}`);
    return;
  }
  started = true;
  $('start').hidden = true;
  void VoiceScore.load().then(vs => { if (vs) duet.vad.voiceScore = f => vs.score(f); });
  duet.start();
  earcon('woke');
});

// A tap anywhere: stop the voice, or cancel the turn Muse is working on.
document.addEventListener('pointerdown', ev => {
  if (!started || (ev.target as HTMLElement).closest('input, button')) return;
  const phase = duet.phase;
  if (speaker.busy) { spokenTurn = duet.turn; speaker.cancel(); }
  if (waiting(phase) || phase === 'asleep' || phase === 'armed' || phase === 'error') duet.gesture('tap'); // never in "confirm": a tap there means yes
});
