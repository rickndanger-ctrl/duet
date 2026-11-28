// Hey Muse's buddy: Musa, Rick's own Muse character (a fuzzy little guy in a knit beanie, big glasses whose temples
// glow like G2, a black tee with a pie on it). The lens picture is his art itself, cut to head and shoulders and shrunk
// to 47x48 (scripts/musa-sprite.mjs, from his master image); each pose repaints only the eyes and
// the mouth. Beside Muse's words: his face from the same art. x 76..95 is left for the effects mascot.ts draws beside it.
import type { PixelArt, Pose } from './mascot';
import { MUSA_GREY, MUSA_W, MUSA_H, MUSA_FACE, MUSA_FACE_SIZE } from './musa-pixels';

/** Where the bust sits in the 96x48 image box. */
const OX = 16;
/** Inside the bust: the two lenses (interiors), their pupils, and the mouth. */
const LENSES = [{ x0: 13, x1: 19, px: 16 }, { x0: 27, x1: 33, px: 29 }];
const EYE_Y0 = 24, EYE_Y1 = 28, PUPIL_Y = 25;
const MOUTH = { x0: 21, x1: 25, y: 30 };

const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
let grey: Uint8Array | undefined;
const source = () => (grey ??= decode(MUSA_GREY));
let faceGrey: Uint8Array | undefined;

/** Musa's own face (from his art) beside Muse's words, mapped for the lens like the bust. */
function face(set: (x: number, y: number, v: number) => void): void {
  const f = (faceGrey ??= decode(MUSA_FACE));
  for (let y = 0; y < MUSA_FACE_SIZE; y++) for (let x = 0; x < MUSA_FACE_SIZE; x++) set(x, y, lensLevel(f[y * MUSA_FACE_SIZE + x], x, y));
}

/**
 * The art's grey to what the lens should be sent. The lens has few usable steps and shows dim greys much brighter than
 * they are (measured in the Even Hub simulator: 28 shows at ~50 %, 60 at ~70 %, 150 and up at 100 %), so the art is
 * mapped to a handful of tiers: black stays off, the dark beanie and tee glow faintly (half their pixels), the fur face
 * is bright.
 */
export function lensLevel(g: number, x = 0, y = 0): number {
  if (g < 18) return 0;
  if (g < 60) return (x + y) % 2 ? 0 : 16; // the dark beanie and tee: every other pixel, so they glow less and the knit shows
  if (g < 110) return 16;
  if (g < 150) return 70;
  if (g < 185) return 140;
  return 255;
}

const LENS_LIT = 255, FUR = 110;

function musa(pose: Pose, set: (x: number, y: number, v?: number) => void): void {
  const g = source();
  const dy = pose === 'talk1' ? -1 : 0;
  const px = (x: number, y: number, v: number) => set(OX + x, y + dy, v);
  for (let y = 0; y < MUSA_H; y++) for (let x = 0; x < MUSA_W; x++) px(x, y, lensLevel(g[y * MUSA_W + x], x, y));

  // Eyes. The art's own eyes are kept for the plain look; other poses repaint the lenses.
  const lens = (fill: number) => { for (const l of LENSES) for (let y = EYE_Y0; y <= EYE_Y1; y++) for (let x = l.x0; x <= l.x1; x++) px(x, y, fill); };
  const pupils = (dx: number, dyEye: number, h = 3) => { lens(LENS_LIT); for (const l of LENSES) for (let y = 0; y < h; y++) { px(l.px + dx, PUPIL_Y + dyEye + y, 0); px(l.px + dx + 1, PUPIL_Y + dyEye + y, 0); } };
  switch (pose) {
    case 'sleep': lens(FUR); for (const l of LENSES) for (let x = l.x0 + 1; x <= l.x1 - 1; x++) px(x, 27, 0); break;
    case 'listen1': case 'listen2': pupils(2, 0); break;
    case 'think1': case 'think2': case 'think3': pupils(1, -1, 2); break;
    case 'work1': pupils(-2, 1); break;
    case 'work2': pupils(2, 1); break;
    case 'ask': pupils(2, -1); break;
    case 'happy': lens(LENS_LIT); for (const l of LENSES) { const c = l.x0 + 3; px(c - 2, 27, 0); px(c - 1, 26, 0); px(c, 25, 0); px(c + 1, 26, 0); px(c + 2, 27, 0); } break;
    case 'oops': lens(LENS_LIT); for (const l of LENSES) for (let i = 0; i < 5; i++) { px(l.x0 + 1 + i, EYE_Y0 + i, 0); px(l.x0 + 5 - i, EYE_Y0 + i, 0); } break;
    default: break;
  }
  // The mouth: open while talking, a bigger smile when happy.
  if (pose === 'talk1') {
    for (let x = MOUTH.x0; x <= MOUTH.x1; x++) { px(x, MOUTH.y, LENS_LIT); px(x, MOUTH.y + 3, LENS_LIT); }
    for (let y = MOUTH.y + 1; y <= MOUTH.y + 2; y++) { px(MOUTH.x0, y, LENS_LIT); px(MOUTH.x1, y, LENS_LIT); for (let x = MOUTH.x0 + 1; x < MOUTH.x1; x++) px(x, y, 0); }
  } else if (pose === 'happy') { px(MOUTH.x0 - 1, MOUTH.y, 0); px(MOUTH.x1 + 1, MOUTH.y, 0); for (let x = MOUTH.x0; x <= MOUTH.x1; x++) px(x, MOUTH.y + 1, 0); }
  else if (pose === 'oops') { for (let x = MOUTH.x0; x <= MOUTH.x1; x++) px(x, MOUTH.y + 1, 0); }
}

/** A plain mark (beanie, glasses, smile; 2x2 px per '#'), kept for a lens that can't show the face. */
const MARK = [
  '.....######.....',
  '...##########...',
  '..############..',
  '..#.#.#..#.#.#..',
  '................',
  '.######..######.',
  '##.##.####.##.##',
  '.######..######.',
  '.....#....#.....',
  '......####......',
];

export const MUSE_GUY_ART: PixelArt = { draw: musa, mark: MARK, markImage: face };
