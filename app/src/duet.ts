// The conversation loop. Wake ("Hey Duet" or a tap) → you talk → Claude's answer streams onto the lens →
// the mic is already open for your reply → … → quiet for a while → back to sleep.
// No buttons inside a conversation: the end of your speech is the send button.
import type { ChatEvent, ChatMessage } from './api';
import { frame, statusLine, turnLines, type Phase, type Turn, BODY_LINES } from './screen';
import { Vad } from './vad';
import { isRealSpeech, matchWake } from './wake';

export interface DuetDeps {
  show: (text: string, now?: boolean) => void;
  mic: (on: boolean) => Promise<boolean>;
  transcribe: (pcm: Uint8Array, mode: 'wake' | 'talk', signal: AbortSignal) => Promise<string>;
  chat: (messages: ChatMessage[], context: Record<string, string>, onEvent: (e: ChatEvent) => void, signal: AbortSignal) => Promise<void>;
  context: () => Record<string, string>;
  log: (line: string) => void;
  /** Phone page mirror: every turn as it changes. */
  onTurn?: (turn: Turn, phase: Phase) => void;
  onPhase?: (phase: Phase) => void;
  onLevel?: (level: number, speaking: boolean) => void;
}

export interface DuetSettings {
  wakeWord: boolean;
  sensitivity: number;
  /** After an answer, how long Duet waits for you to start talking before it sleeps. */
  followUpMs: number;
  /** A new conversation starts when the last turn is older than this. */
  memoryMs: number;
}

export const DEFAULT_SETTINGS: DuetSettings = { wakeWord: true, sensitivity: 6, followUpMs: 20_000, memoryMs: 10 * 60_000 };
const WAKE_MAX_SPEECH_MS = 6000;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export class Duet {
  phase: Phase = 'asleep';
  private note = '';
  settings: DuetSettings;
  private history: ChatMessage[] = [];
  private lastTurnAt = 0;
  turn: Turn | null = null;
  private scroll: number | null = null;
  private answerAbort: AbortController | null = null;
  private sttAbort: AbortController | null = null;
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever what Duet is doing changes; late results from older work are dropped. */
  private gen = 0;
  private inFront = true;
  private greeting = '';
  readonly vad: Vad;

  constructor(private readonly d: DuetDeps, settings: Partial<DuetSettings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.vad = new Vad({
      onSpeechStart: () => this.onSpeechStart(),
      onUtterance: (pcm, ms) => void this.onUtterance(pcm, ms),
      onDiscard: () => this.onDiscard(),
      onLevel: (level, speaking) => this.d.onLevel?.(level, speaking),
    }, { sensitivity: this.settings.sensitivity });
  }

  /** Start (or come back to the front). */
  start(): void { this.sleep(); }

  get awake(): boolean { return this.phase !== 'asleep' && this.phase !== 'armed'; }

  // ---- inputs -------------------------------------------------------------

  audio(pcm: Uint8Array): void { this.vad.push(pcm); }

  gesture(g: 'tap' | 'double' | 'up' | 'down'): void {
    if (g === 'up' || g === 'down') return this.scrollBy(g === 'up' ? -(BODY_LINES - 2) : BODY_LINES - 2);
    if (g === 'double') { if (this.awake) this.sleep(); return; }
    // Tap.
    switch (this.phase) {
      case 'asleep': case 'armed': case 'error': return this.listen(true);
      case 'hearing': if (this.vad.flush()) this.d.log('tap: sent now'); return;
      case 'thinking': case 'searching': case 'answering':
        this.stopAnswer('stopped');
        return this.listen(false);
      case 'listening': case 'your-turn': case 'transcribing': return;
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

  setSensitivity(level: number): void {
    this.settings.sensitivity = level;
    this.vad.options.sensitivity = level;
  }

  newConversation(): void {
    this.stopAnswer('new');
    this.history = [];
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
    this.greeting = '';
    this.setPhase(this.settings.wakeWord ? 'armed' : 'asleep');
    void this.syncMic();
  }

  /** Awake and waiting for you to speak. */
  private listen(fromTap: boolean): void {
    this.gen++;
    this.vad.reset();
    this.vad.options.endSilenceMs = 800;
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
    await this.d.mic(want);
  }

  // ---- speech ------------------------------------------------------------

  private onSpeechStart(): void {
    if (this.phase === 'listening' || this.phase === 'your-turn') {
      clearTimeout(this.followTimer);
      this.setPhase('hearing');
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
      const rest = matchWake(text);
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
      if (!isRealSpeech(text)) { this.setPhase(this.turn ? 'your-turn' : 'listening'); this.armFollowUp(); return; }
      return void this.ask(text);
    }
    // Talking over an answer (barge-in): a real sentence replaces it.
    if (phase === 'thinking' || phase === 'searching' || phase === 'answering') {
      const text = await this.stt(pcm, 'talk', gen, true);
      if (gen !== this.gen || text === null || !isRealSpeech(text) || words(text) < 2) return;
      this.d.log('barge-in');
      this.stopAnswer('interrupted');
      return void this.ask(text);
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

  private async ask(text: string): Promise<void> {
    this.gen++;
    const gen = this.gen;
    clearTimeout(this.followTimer);
    this.greeting = '';
    if (Date.now() - this.lastTurnAt > this.settings.memoryMs) this.history = [];
    this.history.push({ role: 'user', content: text });
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
      await this.d.chat(this.history.slice(), this.d.context(), e => {
        if (gen !== this.gen) return;
        if (e.t === 'search') this.setPhase('searching');
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
    if (failed && !this.turn!.duet.trim()) {
      this.history.pop();
      return this.fail(failed);
    }
    this.history.push({ role: 'assistant', content: this.turn!.duet.trim() || '(no answer)' });
    this.d.log(`answer done ${Math.round(performance.now() - t0)} ms`);
    // Your turn: the mic is already on, just talk.
    this.vad.options.endSilenceMs = 800;
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
    this.d.log(`answer stopped (${why})`);
    const said = this.turn?.duet.trim();
    if (this.history.at(-1)?.role === 'user') {
      if (said) this.history.push({ role: 'assistant', content: `${said} [cut off: the wearer interrupted]` });
      else this.history.pop();
    }
    this.lastTurnAt = Date.now();
  }

  private fail(note: string): void {
    this.note = note.slice(0, 34);
    this.setPhase('error', true);
    clearTimeout(this.errorTimer);
    const gen = this.gen;
    this.errorTimer = setTimeout(() => { if (gen === this.gen && this.phase === 'error') this.listen(false); }, 3500);
  }

  // ---- screen ------------------------------------------------------------

  private setPhase(phase: Phase, now = false): void {
    if (phase !== 'error') this.note = '';
    this.phase = phase;
    this.render(now);
    this.d.onPhase?.(phase);
  }

  private scrollBy(delta: number): void {
    const lines = this.lines();
    const max = Math.max(0, lines.length - BODY_LINES);
    const at = (this.scroll ?? max) + delta;
    this.scroll = at >= max ? null : Math.max(0, at);
    this.render(true);
  }

  private lines(): string[] {
    if (this.greeting && this.awake) return this.turn ? [...turnLines(this.turn, ''), '', this.greeting] : turnLines(null, this.greeting);
    const placeholder = this.phase === 'armed' ? 'Say "Hey Duet" and ask me anything.\n\nOr tap to talk.'
      : this.phase === 'asleep' ? 'Tap and ask me anything.\n\nTurn on "Hey Duet" in the menu to wake me by voice.'
        : "I'm listening. Go ahead.";
    return turnLines(this.turn, placeholder);
  }

  render(now = false): void {
    const f = frame(statusLine(this.phase, this.note), this.lines(), this.scroll);
    if (this.scroll !== null) this.scroll = f.scroll;
    this.d.show(f.text, now);
    if (this.turn) this.d.onTurn?.(this.turn, this.phase);
  }
}
