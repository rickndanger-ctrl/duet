// Draws Hey Muse's 24x24 store icon (2x2 pixels per cell): app/icon-muse.png, or app/icon-muse-spirit.png with `spirit`.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
// Rick's Muse guy (app/src/museguy.ts): beanie, glasses, smile, tee. `spirit` draws the earlier round spirit instead.
const GUY = [
  '...######...',
  '..########..',
  '.##########.',
  '.#.#.##.#.#.',
  '............',
  '#####..#####',
  '#.##.##.##.#',
  '#####..#####',
  '...#....#...',
  '....####....',
  '.##########.',
  '############',
]
const SPIRIT = [
  '.........#..',
  '....####.###',
  '..########.#',
  '.##########.',
  '.###.##.###.',
  '.##########.',
  '.##########.',
  '.##########.',
  '.##########.',
  '.#.##..##.#.',
  '............',
  '............',
]
const spirit = process.argv[2] === 'spirit'
const ART = spirit ? SPIRIT : GUY
const S = 24, rows = []
for (let y = 0; y < S; y++) {
  const row = Buffer.alloc(1 + S * 4)
  for (let x = 0; x < S; x++) if (ART[y >> 1][x >> 1] === '#') { row.fill(0xf4, 1 + x * 4, 4 + x * 4); row[4 + x * 4] = 255 } // Even Hub wants opaque #F4F4F4
  rows.push(row)
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync(new URL(spirit ? '../app/icon-muse-spirit.png' : '../app/icon-muse.png', import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]))
