// The Claude mascot in the corner of the lens, acting out what Duet is doing.
// The body is the pixel creature from Claude Code's start screen (Anthropic's character), drawn on the
// lens in "blocks" of 4x8 pixels (terminal half-blocks are twice as tall as wide). Poses and the little
// effects beside it (sound waves, thought dots, "?", "z") are drawn in plain pixels.
// Pure functions: the drawing and the phase -> animation table are tested without glasses.
import type { Phase } from './screen';

/** The image box on the lens (pixels). */
export const W = 96;
export const H = 48;

/** One block of the body is BW x BH lens pixels. */
const BW = 4, BH = 8;
/** Where the body starts in the box. */
const OX = 0, OY = 4;

export type Pose =
  | 'idle' | 'sleep'
  | 'listen1' | 'listen2'
  | 'think1' | 'think2' | 'think3'
  | 'work1' | 'work2'
  | 'talk1' | 'talk2'
  | 'ask' | 'happy' | 'oops';

const ON = 255, DIM = 120;

// The body, one character per block: '#' filled, 'e' an eye (left empty), '.' nothing.
const BODY = [
  '...############...',
  '...##e######e##...',
  '.################.',
  '...############...',
];
const LEGS_A = '....#.#....#.#....';
const LEGS_B = '.....#.#..#.#.....';
// Arms up (happy): arms move from the middle row to the top corners.
const BODY_UP = [
  '.#.############.#.',
  '..###e######e###..',
  '...############...',
  '...############...',
];

/** One pose as W*H brightness values (0 = off, 255 = full). */
export function sprite(pose: Pose): Uint8Array {
  const g = new Uint8Array(W * H);
  const set = (x: number, y: number, v = ON) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = v; };
  const rect = (x: number, y: number, w: number, h: number, v = ON) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, v); };

  const bob = pose === 'talk1' ? -2 : 0;
  const rows = [...(pose === 'happy' ? BODY_UP : BODY), pose === 'work2' ? LEGS_B : LEGS_A];
  const eyes: { x: number; y: number }[] = [];
  rows.forEach((row, r) => [...row].forEach((c, k) => {
    const x = OX + k * BW, y = OY + bob + r * BH;
    if (c === '#') rect(x, y, BW, BH);
    else if (c === 'e') eyes.push({ x, y });
  }));

  // Eyes: the empty block is the eye. Fill part of it back in for other looks.
  for (const { x, y } of eyes) {
    switch (pose) {
      case 'sleep': rect(x, y, BW, BH); rect(x, y + 5, BW, 1, 0); break; // closed: a thin line
      case 'think1': case 'think2': case 'think3': rect(x, y + 4, BW, 4); break; // looking up
      case 'work1': case 'work2': rect(x, y, BW, 2); rect(x, y + 6, BW, 2); break; // focused
      case 'oops': rect(x, y, BW, BH); set(x, y + 2, 0); set(x + 3, y + 2, 0); set(x + 1, y + 3, 0); set(x + 2, y + 4, 0); set(x, y + 5, 0); set(x + 3, y + 5, 0); set(x + 1, y + 4, 0); set(x + 2, y + 3, 0); break;
      default: break; // wide open
    }
  }

  // Effects to the right of the body (x 76..95).
  const FX = 76;
  switch (pose) {
    case 'sleep':
      rect(FX + 2, 20, 6, 1); set(FX + 6, 21); set(FX + 5, 22); set(FX + 4, 23); set(FX + 3, 24); rect(FX + 2, 25, 6, 1);
      rect(FX + 11, 8, 5, 1, DIM); set(FX + 14, 9, DIM); set(FX + 13, 10, DIM); set(FX + 12, 11, DIM); rect(FX + 11, 12, 5, 1, DIM);
      break;
    case 'listen1': case 'listen2': {
      // Sound waves: ")" arcs, one then two.
      const arc = (x: number, h: number) => { for (let y = -h; y <= h; y++) { const ax = x + Math.round(Math.sqrt(Math.max(0, h * h - y * y)) / 2); set(ax, 22 + y); set(ax + 1, 22 + y); } };
      arc(FX + 1, 6);
      if (pose === 'listen2') arc(FX + 8, 11);
      break;
    }
    case 'think1': case 'think2': case 'think3': {
      const n = pose === 'think1' ? 1 : pose === 'think2' ? 2 : 3;
      rect(FX + 1, 14, 3, 3);
      if (n >= 2) rect(FX + 6, 7, 4, 4);
      if (n >= 3) rect(FX + 12, 0, 5, 5);
      break;
    }
    case 'work1': case 'work2': {
      // A twinkling spark.
      const cx = FX + 9, cy = 12, big = pose === 'work1' ? 5 : 3;
      for (let i = -big; i <= big; i++) { set(cx + i, cy); set(cx, cy + i); }
      if (pose === 'work2') for (let i = 1; i <= 2; i++) { set(cx + i, cy + i); set(cx - i, cy - i); set(cx + i, cy - i); set(cx - i, cy + i); }
      break;
    }
    case 'ask': {
      // "?"
      const qx = FX + 6;
      rect(qx + 1, 6, 6, 2); rect(qx, 8, 2, 3); rect(qx + 6, 8, 2, 5); rect(qx + 4, 13, 3, 2); rect(qx + 3, 15, 2, 4); rect(qx + 3, 22, 2, 2);
      break;
    }
    default: break;
  }
  return g;
}

/** The poses to cycle through for each phase, and how long each frame shows. One frame = no animation. */
export function animation(phase: Phase): { poses: Pose[]; ms: number } {
  switch (phase) {
    case 'asleep': return { poses: ['sleep'], ms: 0 };
    case 'armed': return { poses: ['idle'], ms: 0 };
    case 'listening': return { poses: ['listen1', 'listen2'], ms: 700 };
    case 'hearing': return { poses: ['listen1', 'listen2'], ms: 450 };
    case 'transcribing':
    case 'thinking': return { poses: ['think1', 'think2', 'think3'], ms: 500 };
    case 'working': return { poses: ['work1', 'work2'], ms: 500 };
    case 'answering': return { poses: ['talk1', 'talk2'], ms: 500 };
    case 'your-turn': return { poses: ['happy'], ms: 0 };
    case 'confirm': return { poses: ['ask'], ms: 0 };
    case 'error': return { poses: ['oops'], ms: 0 };
  }
}

// ---- the gutter beside the conversation ---------------------------------------------------------------
/** Each gutter image covers 4 body rows (the lens allows images up to 144 px tall). */
export const GUTTER_W = 38, GUTTER_ROWS = 4, ROW_PX = 27, GUTTER_H = GUTTER_ROWS * ROW_PX;
/** Where a mark starts inside its row (the text's capitals start ~6 px into a row). */
const MARK_Y = 4;

// "ME" in a 5x7 pixel font.
const ME = [
  '10001.11111',
  '11011.10000',
  '10101.10000',
  '10101.11110',
  '10001.10000',
  '10001.10000',
  '10001.11111',
];

/** One gutter image: the marks for its 4 rows ('me' = ME, 'claude' = a tiny Claude, null = nothing). */
export function gutter(marks: ('me' | 'claude' | null)[]): Uint8Array {
  const g = new Uint8Array(GUTTER_W * GUTTER_H);
  const rect = (x: number, y: number, w: number, h: number) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (x + i < GUTTER_W && y + j < GUTTER_H) g[(y + j) * GUTTER_W + x + i] = ON; };
  marks.slice(0, GUTTER_ROWS).forEach((m, r) => {
    const top = r * ROW_PX + MARK_Y;
    if (m === 'claude') {
      // The buddy at 2 x 4 px per block: 36 x 20.
      [...BODY, LEGS_A].forEach((row, k) => [...row].forEach((c, i) => { if (c === '#') rect(1 + i * 2, top + k * 4, 2, 4); }));
    } else if (m === 'me') {
      ME.forEach((row, k) => [...row].forEach((c, i) => { if (c === '1') rect(5 + i * 2, top + 3 + k * 2, 2, 2); }));
    }
  });
  return g;
}

/** Text art of a pose (every other row, since blocks are tall), for eyeballing the design in a terminal. */
export function ascii(pose: Pose): string {
  const s = sprite(pose);
  const rows: string[] = [];
  for (let y = 0; y < H; y += 2) rows.push(Array.from(s.slice(y * W, (y + 1) * W), v => (v === 0 ? '.' : v === ON ? '#' : '+')).join(''));
  return rows.join('\n');
}
