import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animation, sprite, W, H, type Pose } from '../src/mascot.ts';
import type { Phase } from '../src/screen.ts';

const PHASES: Phase[] = ['asleep', 'armed', 'listening', 'hearing', 'transcribing', 'thinking', 'working', 'answering', 'your-turn', 'confirm', 'error'];

test('every phase has a mascot animation that can be drawn', () => {
  for (const p of PHASES) {
    const { poses, ms } = animation(p);
    assert.ok(poses.length >= 1, p);
    if (poses.length > 1) assert.ok(ms >= 400, `${p} animates no faster than the Bluetooth link likes`);
    for (const pose of poses) assert.ok(sprite(pose).some(v => v > 0), `${pose} draws something`);
  }
});

test('poses differ where they should', () => {
  const same = (a: Pose, b: Pose) => sprite(a).every((v, i) => v === sprite(b)[i]);
  for (const [a, b] of [['listen1', 'listen2'], ['think1', 'think3'], ['work1', 'work2'], ['talk1', 'talk2'], ['idle', 'happy'], ['idle', 'sleep']] as [Pose, Pose][])
    assert.ok(!same(a, b), `${a} vs ${b}`);
});

test('the lens image fits the image container limits', () => {
  assert.ok(W >= 20 && W <= 288 && H >= 20 && H <= 144);
  assert.equal(sprite('ask').length, W * H);
});

test('the gutter draws ME and a tiny Claude only on their rows', async () => {
  const { gutter, GUTTER_W, ROW_PX } = await import('../src/mascot.ts');
  const g = gutter(['me', null, 'claude', null]);
  const rowLit = (r: number) => { for (let y = r * ROW_PX; y < (r + 1) * ROW_PX; y++) for (let x = 0; x < GUTTER_W; x++) if (g[y * GUTTER_W + x]) return true; return false; };
  assert.deepEqual([0, 1, 2, 3].map(rowLit), [true, false, true, false]);
  assert.ok(gutter([null, null, null, null]).every(v => v === 0));
});
