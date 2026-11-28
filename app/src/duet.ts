// The conversation loop. Wake ("Hey Duet" or a tap) → you talk → Claude's answer streams onto the lens →
// the mic is already open for your reply → … → quiet for a while → back to sleep.
// No buttons inside a conversation: the end of your speech is the send button.
import type { ChatEvent } from './api';
import { body, clock, frame, statusLine, turnBody, type Body, type Mark, type Phase, type Turn, BODY_LINES } from './screen';
import { Vad } from './vad';
import { confirmReply, isRealSpeech, isShortReply, yesNo, HEY_DUET, type WakeWord } from './wake';

export interface DuetDeps {
  /** The lens text, and who speaks on each of the 8 body rows (marks in the gutter). */
  show: (text: string, now?: boolean, marks?: Mark[]) => void;
  /** The clock in the lens' top-right corner (called when the minute changes). */
  clock?: (text: string) => void;
  mic: (on: boolean) => Promise<boolean>;
  transcribe: (pcm: Uint8Array, mode: 'wake' | 'talk', signal: AbortSignal) => Promise<string>;
  chat: (conversation: string, text: string, context: Record<string, string>, onEvent: (e: ChatEvent) => void, signal: AbortSignal) => Promise<void>;
  /** The wearer's yes/no to an action Claude prepared (send an email, move a meeting). */
  confirm: (id: string, ok: boolean, change?: string) => Promise<void>;
  context: () => Record<string, string>;
  log: (line: string) => void;
  /** Phone page mirror: every turn as it changes. */
  onTurn?: (turn: Turn, phase: Phase) => void;
  onPhase?: (phase: Phase) => void;
  onLevel?: (level: number, speaking: boolean) => void;
  /** The time (tests set it). */
  now?: () => Date;
  /** The wake word (default "Hey Duet"). */
  wake?: WakeWord;
  /** Silence that ends what you say (default 1 s). A slower assistant can afford to wait a little longer. */
  talkEndSilenceMs?: number;
  /** A lone "yeah" / "okay" after an answer goes out only when the answer asked something (default: also yes/no and
   *  clearly heard short replies). For an assistant that takes a while to answer, a nod shouldn't cost a turn. */
  shortRepliesOnlyIfAsked?: boolean;
}

export interface DuetSettings {
  wakeWord: boolean;
  sensitivity: number;
  /** After an answer, how long Duet waits for you to start talking before it sleeps. */
  followUpMs: number;
  /** A new conversation starts when the last turn is older than this. */
  memoryMs: number;
  /** Once you've been talking a while, how long a pause (finding the words) can last before what you said is sent. */
  pauseMs: number;
}

export const DEFAULT_SETTINGS: DuetSettings = { wakeWord: true, sensitivity: 6, followUpMs: 20_000, memoryMs: 10 * 60_000, pauseMs: 3500 };
const WAKE_MAX_SPEECH_MS = 6000;
/** A short reply ("Okay.") counts when the mic heard at least this much speech (Whisper invents "Okay." from noise). */
const SHORT_REPLY_SPEECH_MS = 300;
/** You paused mid-sentence and went on: what you add this soon after (before Claude has answered) joins the first part. */
const JOIN_MS = 6000;
/** Silence that ends what you say. Longer than a breath between phrases. */
const TALK_END_SILENCE_MS = 1000;
/** Talking a while (a paragraph, not a quick question): a pause to find the words has to last settings.pauseMs
 *  (3.5 s by default, what felt right on the glasses) to send it. A tap sends at once. */
const TALK_LONG_AFTER_MS = 2500;
const LONG_HEARING_MS = 20_000;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
/** Phases where Claude is busy with this turn (talking over them interrupts). */
const BUSY: Phase[] = ['thinking', 'working', 'answering'];

export class Duet {
  phase: Phase = 'asleep';
  private note = '';
  settings: DuetSettings;
  /** The server keeps the conversation (tool calls included); this names it. */
  private conversation = newId();
  private confirmReq: { id: string; verb: string; prompt: string } | null = null;
  private lastTurnAt = 0;
  /** What was last sent to Claude, and when (to join a sentence you finished after a pause). */
  private asked = { text: '', at: 0 };
  turn: Turn | null = null;
  private scroll: number | null = null;
  private answerAbort: AbortController | null = null;
  private sttAbort: AbortController | null = null;
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;
  private shownClock = '';
  private micOn = false;
  private longTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever what Duet is doing changes; late results from older work are dropped. */
  private gen = 0;
  private inFront = true;
  private greeting = '';
  readonly vad: Vad;
  private readonly wake: WakeWord;
  private readonly talkEnd: number;

  constructor(private readonly d: DuetDeps, settings: Partial<DuetSettings> = {}) {
    this.wake = d.wake ?? HEY_DUET;
    this.talkEnd = d.talkEndSilenceMs ?? TALK_END_SILENCE_MS;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.vad = new Vad({
      onSpeechStart: () => this.onSpeechStart(),
      onUtterance: (pcm, ms) => void this.onUtterance(pcm, ms),
      onDiscard: () => this.onDiscard(),
      onLevel: (level, speaking) => this.d.onLevel?.(level, speaking),
    }, { sensitivity: this.settings.sensitivity });
  }

  /** Start (or come back to the front). */
  start(): void {
    this.sleep();
    // The clock in the corner: sent when the minute changes.
    clearInterval(this.clockTimer);
    const tick = () => { const c = this.clockText(); if (c !== this.shownClock) { this.shownClock = c; this.d.clock?.(c); } };
    tick();
    this.clockTimer = setInterval(tick, 5_000);
    (this.clockTimer as { unref?: () => void }).unref?.(); // don't keep tests alive
  }

  private clockText(): string { return clock(this.d.now?.() ?? new Date()); }

  get awake(): boolean { return this.phase !== 'asleep' && this.phase !== 'armed'; }

  // ---- inputs -------------------------------------------------------------

  audio(pcm: Uint8Array): void { this.vad.push(pcm); }

  gesture(g: 'tap' | 'double' | 'up' | 'down'): void {
    if (g === 'up' || g === 'down') return this.scrollBy(g === 'up' ? -(BODY_LINES - 2) : BODY_LINES - 2);
    if (this.phase === 'confirm' && (g === 'tap' || g === 'double')) return this.answerConfirm(g === 'tap', 'touch');
    if (g === 'double') { if (this.awake) this.sleep(); return; }
    // Tap.
    switch (this.phase) {
      case 'asleep': case 'armed': case 'error': return this.listen(true);
      case 'hearing': if (this.vad.flush()) this.d.log('tap: sent now'); return;
      case 'thinking': case 'working': case 'answering':
        this.stopAnswer('stopped');
        return this.listen(false);
      case 'listening': case 'your-turn': case 'transcribing': case 'confirm': return;
    }
  }

  foreground(front: boolean): void {
    this.inFront = front;
    if (!front) { this.stopAnswer('left'); this.gen++; this.setPhase(this.settings.wakeWord ? 'armed' : 'asleep'); void this.syncMic(); return; }
    this.render(true);
    void this.syncMic();
  }

  setWakeWord(on: boolean): void {
    this.settings.wakeWord = on;
    if (!this.awake) this.sleep();
  }

  /** How long a pause mid-paragraph can last before what you said is sent (2-8 s). */
  setPause(ms: number): void {
    this.settings.pauseMs = Math.min(8000, Math.max(2000, ms || DEFAULT_SETTINGS.pauseMs));
    if (this.vad.options.longAfterMs !== Infinity) this.vad.options.longEndSilenceMs = this.settings.pauseMs;
  }

  setSensitivity(level: number): void {
    this.settings.sensitivity = level;
    this.vad.options.sensitivity = level;
  }

  newConversation(): void {
    this.stopAnswer('new');
    this.conversation = newId();
    this.turn = null;
    this.sleep();
  }

  // ---- states ------------------------------------------------------------

  /** Asleep (tap to talk) or armed (listening only for "Hey Duet"). The last answer stays readable. */
  sleep(): void {
    this.stopAnswer('sleep');
    this.gen++;
    this.sttAbort?.abort();
    clearTimeout(this.followTimer);
    this.vad.reset();
    this.vad.options.endSilenceMs = 500;
    this.vad.options.longAfterMs = Infinity;
    this.greeting = '';
    this.setPhase(this.settings.wakeWord ? 'armed' : 'asleep');
    void this.syncMic();
  }

  /** Awake and waiting for you to speak. */
  private listen(fromTap: boolean): void {
    this.gen++;
    this.vad.reset();
    this.vad.options.endSilenceMs = this.talkEnd;
    this.vad.options.longAfterMs = TALK_LONG_AFTER_MS;
    this.vad.options.longEndSilenceMs = this.settings.pauseMs;
    if (fromTap && (!this.turn || Date.now() - this.lastTurnAt > this.settings.memoryMs)) this.greeting = "I'm listening. Go ahead.";
    this.setPhase(this.turn ? 'your-turn' : 'listening');
    this.armFollowUp();
    void this.syncMic();
  }

  private armFollowUp(): void {
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      if (this.phase === 'listening' || this.phase === 'your-turn') { this.d.log('quiet: going to sleep'); this.sleep(); }
    }, this.settings.followUpMs);
  }

  private async syncMic(): Promise<void> {
    const want = this.inFront && (this.settings.wakeWord || this.awake);
    // A mic that was off is in a new place (or the room changed): learn its noise from scratch.
    if (want && !this.micOn) this.vad.restart();
    this.micOn = want;
    await this.d.mic(want);
  }

  // ---- speech ------------------------------------------------------------

  private onSpeechStart(): void {
    if (this.phase === 'listening' || this.phase === 'your-turn') {
      clearTimeout(this.followTimer);
      this.setPhase('hearing');
      // Still "hearing" after a while: probably noise, or a long thought. Say how to send it now.
      const gen = this.gen;
      clearTimeout(this.longTimer);
      this.longTimer = setTimeout(() => { if (gen === this.gen && this.phase === 'hearing') this.setPhase('hearing', true, 'long'); }, LONG_HEARING_MS);
    }
  }

  private onDiscard(): void {
    if (this.phase === 'hearing') { this.setPhase(this.turn ? 'your-turn' : 'listening'); this.armFollowUp(); }
  }

  private async onUtterance(pcm: Uint8Array, speechMs: number): Promise<void> {
    const phase = this.phase;
    const gen = this.gen;
    if (phase === 'asleep' || phase === 'transcribing') return;
    if (phase === 'armed') {
      if (speechMs > WAKE_MAX_SPEECH_MS) return;
      const text = await this.stt(pcm, 'wake', gen);
      if (text === null || gen !== this.gen || this.phase !== 'armed') return;
      const rest = this.wake.match(text);
      this.d.log(rest === null ? 'not a wake' : 'wake!');
      if (rest === null) return;
      if (isRealSpeech(rest) && words(rest) >= 2) return void this.ask(rest);
      this.greeting = 'Yes?';
      return this.listen(false);
    }
    if (phase === 'hearing' || phase === 'listening' || phase === 'your-turn') {
      this.setPhase('transcribing');
      const text = await this.stt(pcm, 'talk', gen);
      if (gen !== this.gen) return;
      if (text === null) return; // error already shown
      if (this.wake.isPause(text)) { this.d.log('pause'); return this.sleep(); }
      const said = this.withoutWake(text);
      if (said === '') { this.greeting = 'Yes?'; return this.listen(false); } // "Hey Duet" while already awake
      // Waiting for a follow-up, one word is usually a noise heard as a word (a door squeak became "screams"),
      // unless Claude just asked something ("Want me to change it?" "Sure."), it's a yes / no, or a short reply
      // ("Okay.") the mic clearly heard.
      const followUp = this.turn !== null && !this.greeting;
      const asked = /\?["')\s]*$/.test(this.turn?.duet ?? '');
      const shortReply = isShortReply(said) && speechMs >= SHORT_REPLY_SPEECH_MS;
      const oneWordOk = !followUp || asked || (!this.d.shortRepliesOnlyIfAsked && (yesNo(said) !== null || shortReply));
      if (!(isRealSpeech(said) || shortReply) || (words(said) < 2 && !oneWordOk)) { this.d.log(`ignored "${said.slice(0, 40)}"`); this.setPhase(this.turn ? 'your-turn' : 'listening'); this.armFollowUp(); return; }
      return void this.ask(said);
    }
    // "Send it?" answered by voice.
    if (phase === 'confirm') {
      const text = await this.stt(pcm, 'talk', gen, true);
      if (gen !== this.gen || text === null || this.phase !== 'confirm') return;
      const reply = confirmReply(text);
      this.d.log(`confirm heard: ${reply === null ? 'neither' : reply.change ? 'a change' : reply.ok ? 'yes' : 'no'}`);
      if (reply) this.answerConfirm(reply.ok, 'voice', reply.change);
      return;
    }
    // Talking over an answer (barge-in): a real sentence replaces it.
    if (BUSY.includes(phase)) {
      const text = await this.stt(pcm, 'talk', gen, true);
      if (gen !== this.gen || text === null) return;
      if (this.wake.isPause(text)) { this.d.log('pause'); return this.sleep(); }
      const said = this.withoutWake(text);
      if (!said || !isRealSpeech(said)) return;
      // You paused mid-sentence and went on before Claude answered: it's the rest of the same message.
      const joining = !this.turn?.duet.trim() && Date.now() - this.asked.at < JOIN_MS && this.asked.text !== '';
      if (joining) { this.d.log('joined to the last message'); this.stopAnswer('joined'); return void this.ask(`${this.asked.text} ${said}`); }
      if (words(said) < 2) return;
      // A leftover "yes yes" or "okay" after a confirm is not a new question: don't cut the answer off for it.
      if (yesNo(said) !== null && words(said) <= 4) { this.d.log('ignored short reply while busy'); return; }
      this.d.log('barge-in');
      this.stopAnswer('interrupted');
      return void this.ask(said);
    }
  }

  private async stt(pcm: Uint8Array, mode: 'wake' | 'talk', gen: number, quiet = false): Promise<string | null> {
    const abort = new AbortController();
    if (!quiet) { this.sttAbort?.abort(); this.sttAbort = abort; }
    const t0 = performance.now();
    try {
      const text = await this.d.transcribe(pcm, mode, abort.signal);
      this.d.log(`stt ${mode} ${Math.round(performance.now() - t0)} ms`);
      return text;
    } catch (e) {
      if (abort.signal.aborted || gen !== this.gen) return null;
      if (mode === 'wake' || quiet) { this.d.log(`stt failed: ${(e as Error).message}`); return null; }
      this.fail((e as Error).message || 'could not hear that');
      return null;
    }
  }

  // ---- Claude ------------------------------------------------------------

  /** The words after "Hey Duet" if it starts with it ('' = just the name); otherwise the text as is. */
  private withoutWake(text: string): string {
    const rest = this.wake.match(text);
    return rest === null ? text : rest;
  }

  private async ask(text: string): Promise<void> {
    this.asked = { text, at: Date.now() };
    this.gen++;
    const gen = this.gen;
    clearTimeout(this.followTimer);
    this.greeting = '';
    if (this.lastTurnAt && Date.now() - this.lastTurnAt > this.settings.memoryMs) this.conversation = newId();
    this.turn = { you: text, duet: '' };
    this.scroll = null;
    this.setPhase('thinking', true);
    this.vad.reset();
    const abort = new AbortController();
    this.answerAbort = abort;
    const t0 = performance.now();
    let firstAt = 0;
    let failed = '';
    try {
      await this.d.chat(this.conversation, text, this.d.context(), e => {
        if (gen !== this.gen) return;
        if (e.t === 'status') this.setPhase('working', false, e.text);
        else if (e.t === 'confirm') this.askConfirm(e);
        else if (e.t === 'delta') {
          if (!firstAt) { firstAt = performance.now(); this.d.log(`first words ${Math.round(firstAt - t0)} ms`); }
          this.turn!.duet += e.text;
          if (this.phase !== 'answering') this.setPhase('answering', true); else this.render();
        } else if (e.t === 'error') failed = e.message;
      }, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) failed = (e as Error).message || 'Claude did not answer';
    }
    if (this.answerAbort === abort) this.answerAbort = null;
    if (gen !== this.gen) return;
    this.lastTurnAt = Date.now();
    this.confirmReq = null;
    if (failed && !this.turn!.duet.trim()) return this.fail(failed);
    this.d.log(`answer done ${Math.round(performance.now() - t0)} ms`);
    // Your turn: the mic is already on, just talk.
    this.vad.options.endSilenceMs = this.talkEnd;
    this.vad.options.longAfterMs = TALK_LONG_AFTER_MS;
    this.vad.options.longEndSilenceMs = this.settings.pauseMs;
    this.setPhase('your-turn', true);
    this.armFollowUp();
    void this.syncMic();
  }

  /** Stops a streaming answer; what was shown stays in the history, marked as cut short. */
  private stopAnswer(why: string): void {
    const abort = this.answerAbort;
    if (!abort) return;
    this.answerAbort = null;
    abort.abort();
    this.d.log(`answer stopped (${why})`); // the server closes the turn and keeps what was said
    this.confirmReq = null;
    this.lastTurnAt = Date.now();
  }

  // ---- confirming actions ------------------------------------------------

  /** Claude prepared an action: show the exact draft and wait for yes / no (voice, or tap / double tap). */
  private askConfirm(req: { id: string; verb: string; prompt: string }): void {
    this.confirmReq = req;
    this.scroll = null;
    this.vad.reset();
    this.vad.options.endSilenceMs = 600;
    this.vad.options.longAfterMs = Infinity;
    this.setPhase('confirm', true, req.verb);
    void this.syncMic();
  }

  /** `change`: the wearer said what to do differently; Claude redrafts and asks again. */
  private answerConfirm(ok: boolean, how: string, change?: string): void {
    const req = this.confirmReq;
    if (!req) return;
    this.confirmReq = null;
    this.d.log(`confirm ${change ? 'change' : ok ? 'yes' : 'no'} by ${how}`);
    if (change && this.turn) this.turn.you = change;
    this.setPhase('working', true, change ? 'changing it' : ok ? (req.verb === 'Send' ? 'sending' : 'saving') : 'cancelled');
    this.d.confirm(req.id, ok, change).catch(e => this.d.log(`confirm failed: ${(e as Error).message}`));
  }

  private fail(note: string): void {
    this.note = note.slice(0, 34);
    this.setPhase('error', true);
    clearTimeout(this.errorTimer);
    const gen = this.gen;
    this.errorTimer = setTimeout(() => { if (gen === this.gen && this.phase === 'error') this.listen(false); }, 3500);
  }

  // ---- screen ------------------------------------------------------------

  private setPhase(phase: Phase, now = false, note = ''): void {
    if (phase !== 'error') this.note = note;
    this.phase = phase;
    this.render(now);
    this.d.onPhase?.(phase);
  }

  private scrollBy(delta: number): void {
    const lines = this.lines().lines;
    const max = Math.max(0, lines.length - BODY_LINES);
    const at = (this.scroll ?? max) + delta;
    this.scroll = at >= max ? null : Math.max(0, at);
    this.render(true);
  }

  private lines(): Body {
    if (this.phase === 'confirm' && this.confirmReq) {
      const verb = this.confirmReq.verb.toLowerCase();
      return body([{ who: 'claude', text: this.confirmReq.prompt }, { who: null, text: `Say YES to ${verb}, NO to cancel.\n(tap = yes, double tap = no)` }]);
    }
    const hint = (text: string) => ({ who: null, text });
    const said = this.turn ? [{ who: 'me' as Mark, text: this.turn.you }, { who: 'claude' as Mark, text: this.turn.duet }] : [];
    // While you talk (and while it's being written down), your line is already there: "ME …".
    if (this.phase === 'hearing' || this.phase === 'transcribing') return body([...said, ...(this.greeting ? [{ who: 'claude' as Mark, text: this.greeting }] : []), { who: 'me', text: '…' }]);
    if (this.greeting && this.awake) return body([...said, { who: 'claude', text: this.greeting }]);
    const placeholder = this.phase === 'armed' ? `Say "${this.wake.label}" and ask me anything.\n\nOr tap to talk.`
      : this.phase === 'asleep' ? `Tap and ask me anything.\n\nTurn on "${this.wake.label}" in the menu to wake me by voice.`
        : "I'm listening. Go ahead.";
    const b = turnBody(this.turn, placeholder);
    // On your turn, say how to stop (Duet keeps listening otherwise), when it fits without pushing the answer off the top.
    if (this.turn && (this.phase === 'your-turn' || this.phase === 'listening') && b.lines.length + 2 <= BODY_LINES) return body([{ who: 'me', text: this.turn.you }, { who: 'claude', text: this.turn.duet }, hint('Say "pause" or double tap to stop listening.')]);
    // Paused with an answer on screen: say how to wake.
    if (this.turn && !this.awake && b.lines.length + 2 <= BODY_LINES) return body([{ who: 'me', text: this.turn.you }, { who: 'claude', text: this.turn.duet }, hint(this.phase === 'armed' ? `Say "${this.wake.label}" or tap to talk.` : 'Tap to talk.')]);
    return b;
  }

  render(now = false): void {
    const f = frame(statusLine(this.phase, this.note, this.wake.label), this.lines(), this.scroll);
    if (this.scroll !== null) this.scroll = f.scroll;
    this.d.show(f.text, now, f.marks);
    if (this.turn) this.d.onTurn?.(this.turn, this.phase);
  }
}
