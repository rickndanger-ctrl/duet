// What the lens shows. Top row: a short status on the left, the buddy in the middle, the clock on the right.
// Below: the conversation. Your words and Claude's are indented past a narrow left gutter where small marks show who is
// speaking: "ME" beside your words, a tiny Claude beside his. Pure functions, so the layout is tested without glasses.
// Measured on the G2 font (Even Hub simulator, 2026-11-27): a space is 5 px, '─' is 20 px, lines are 27 px apart,
// "checking your calendar…" is 205 px, "Fri, Nov 27 · 12:59 PM" is 186 px.

/** Characters per line that safely fit the 576 px wide text box (the font is proportional; this is the safe count). */
export const COLS = 56;
/** Body lines under the status line. */
export const BODY_LINES = 8;
/** The gutter: this many spaces (5 px each) before every body line leave 40 px for the speaker marks. */
export const INDENT = 8;
const PAD = ' '.repeat(INDENT);
/** Characters per body line after the gutter. */
export const BODY_COLS = COLS - 4;
/** The divider under the status line, across the lens (the buddy covers its middle). */
const RULE = 28;
/** The status has to end before the buddy (x 240): at most this many characters. */
export const STATUS_MAX = 24;

export type Phase = 'asleep' | 'armed' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'working' | 'answering' | 'your-turn' | 'confirm' | 'error';
/** Who a body line belongs to: the first line of each speaker gets a mark in the gutter. */
export type Mark = 'me' | 'claude' | null;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Whether the wearer should talk now or wait, in a few words (the clock has its own corner). */
export function statusLine(phase: Phase, note = '', wake = 'Hey Duet'): string {
  const label: Record<Phase, string> = {
    asleep: 'PAUSED · tap to talk',
    armed: `PAUSED · "${wake}"`,
    listening: 'TALK NOW',
    hearing: note ? 'HEARING · tap to send' : 'HEARING YOU…',
    transcribing: 'WAIT · got it…',
    thinking: 'WAIT · thinking…',
    working: `${cut(note || 'working', STATUS_MAX - 1)}…`,
    answering: 'WAIT · answering…',
    'your-turn': 'TALK NOW · your turn',
    confirm: `${note || 'Send'}?  YES / NO`,
    error: '! ' + (note || 'something went wrong'),
  };
  return cut(label[phase], STATUS_MAX);
}

/** The clock in the top-right corner: "Fri, Nov 27 · 3:42 PM" (the phone's 12/24 h style). */
export function clock(d: Date): string {
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${date} · ${time}`.replace(/[  ]/g, ' ');
}

/** Word wrap to `cols`; long words are split. Keeps blank lines (paragraphs). */
export function wrap(text: string, cols = COLS): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    let line = '';
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > cols) {
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, cols)); word = word.slice(cols);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export interface Turn { you: string; duet: string }

/** Body lines with who said each: the first line of each speaker carries their mark. */
export interface Body { lines: string[]; marks: Mark[] }

export function body(parts: { who: Mark; text: string }[]): Body {
  const lines: string[] = [], marks: Mark[] = [];
  for (const p of parts) {
    const w = wrap(p.text, BODY_COLS);
    if (!w.length) continue;
    if (lines.length) { lines.push(''); marks.push(null); } // a breath between speakers (and before a hint)
    w.forEach((l, i) => { lines.push(l); marks.push(i === 0 ? p.who : null); });
  }
  return { lines, marks };
}

/** A conversation turn: what you said (all of it), then Claude's answer. */
export function turnBody(turn: Turn | null, placeholder: string): Body {
  if (!turn) return body([{ who: 'claude', text: placeholder }]);
  return body([{ who: 'me', text: turn.you }, { who: 'claude', text: turn.duet }]);
}

/**
 * The frame: status line, divider, then BODY_LINES of the body starting at `scroll`.
 * scroll = null follows the end (newest text), like a live caption. `marks` are the gutter marks for the rows shown.
 */
export function frame(status: string, b: Body, scroll: number | null): { text: string; scroll: number; maxScroll: number; marks: Mark[] } {
  const maxScroll = Math.max(0, b.lines.length - BODY_LINES);
  const at = scroll === null ? maxScroll : Math.min(Math.max(0, scroll), maxScroll);
  const rows = b.lines.slice(at, at + BODY_LINES).map(l => (l ? PAD + l : ''));
  const marks = b.marks.slice(at, at + BODY_LINES);
  // Scrolled into the middle of someone's words: mark the top row with whoever is speaking there.
  if (rows.length && rows[0] && !marks[0]) for (let i = at; i >= 0; i--) { if (!b.lines[i]) break; if (b.marks[i]) { marks[0] = b.marks[i]; break; } }
  while (marks.length < BODY_LINES) marks.push(null);
  const more = at + BODY_LINES < b.lines.length;
  if (more && rows.length) rows[rows.length - 1] += '  ▼';
  const text = [status, '─'.repeat(RULE), ...rows].join('\n');
  return { text, scroll: at, maxScroll, marks };
}

/** Only characters the glasses' font can draw (emoji and other symbols can hang a text update). */
export function glassesSafe(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\t/g, '  ')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/^( *)[*•]\s+/gm, '$1- ')
    .replace(/[^\n\x20-\x7E -ÿ·•…›»→←▲▼─│]/gu, '');
}
