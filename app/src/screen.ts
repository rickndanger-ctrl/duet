// What the lens shows: one status line and the conversation, word-wrapped to the G2's width.
// Pure functions, so the layout can be tested without glasses.

/** Characters per line that safely fit the 576 px wide text box (the font is proportional; this is the safe count). */
export const COLS = 56;
/** Body lines under the status line. */
export const BODY_LINES = 8;
/** The divider: '─' is wide in the G2 font; this many fill most of the line without wrapping. */
const RULE = 26;

export type Phase = 'asleep' | 'armed' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'working' | 'answering' | 'your-turn' | 'confirm' | 'error';

export function statusLine(phase: Phase, note = ''): string {
  const label: Record<Phase, string> = {
    asleep: 'tap to talk',
    armed: 'say "Hey Duet"',
    listening: 'listening…',
    hearing: 'hearing you…',
    transcribing: 'got it…',
    thinking: 'thinking…',
    working: (note || 'working') + '…',
    confirm: `${note || 'Send'}?  yes / no`,
    answering: 'answering…',
    'your-turn': 'your turn - just talk',
    error: '! ' + (note || 'something went wrong'),
  };
  return `DUET  ·  ${label[phase]}`;
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

/** All body lines for a conversation turn: your words (one quoted line, cut), then Duet's answer. */
export function turnLines(turn: Turn | null, placeholder: string): string[] {
  if (!turn) return wrap(placeholder);
  const you = turn.you ? wrap('» ' + turn.you) : [];
  const youLine = you.length > 1 ? [you[0].slice(0, COLS - 1) + '…'] : you;
  const answer = wrap(turn.duet);
  return [...youLine, ...(answer.length ? answer : [])];
}

/**
 * The frame: status line, then BODY_LINES of the body starting at `scroll`.
 * scroll = null follows the end (newest text), like a live caption.
 */
export function frame(status: string, lines: string[], scroll: number | null): { text: string; scroll: number; maxScroll: number } {
  const maxScroll = Math.max(0, lines.length - BODY_LINES);
  const at = scroll === null ? maxScroll : Math.min(Math.max(0, scroll), maxScroll);
  const body = lines.slice(at, at + BODY_LINES);
  const more = at + BODY_LINES < lines.length;
  if (more && body.length) body[body.length - 1] += '  ▼';
  const text = [status, '─'.repeat(RULE), ...body].join('\n');
  return { text, scroll: at, maxScroll };
}

/** Only characters the glasses' font can draw (emoji and other symbols can hang a text update). */
export function glassesSafe(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\t/g, '  ')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/[^\n\x20-\x7E\u00A0-\u00FF·•…›»→←▲▼─│]/gu, '');
}
