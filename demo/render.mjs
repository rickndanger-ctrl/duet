// Renders the demo video from timeline.json (lens frames + spoken clips + fan noise): title card, the recorded
// session with scene captions and subtitles, a how-it-works card and an end card. 1920x1080, 30 fps.
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
const D = new URL('.', import.meta.url).pathname
const tl = JSON.parse(readFileSync(D + 'timeline.json', 'utf8'))
const OUT = process.argv[2] || D + 'duet-demo.mp4'
const W = 1920, H = 1080, FPS = 30
const REG = '/usr/share/fonts/noto/NotoSans-Regular.ttf', BOLD = '/usr/share/fonts/noto/NotoSans-Bold.ttf'
mkdirSync(D + 'txt', { recursive: true }); mkdirSync(D + 'parts', { recursive: true })
let tn = 0
const tf = s => { const f = `${D}txt/${tn++}.txt`; writeFileSync(f, s); return f }
const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' })
const dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }))
const BG = '0x0b0f0c', GREEN = '0x39ff5a', DIM = '0x9fb3a4'
/** drawtext, centered horizontally unless x is given. */
const text = (s, { size, y, font = REG, color = 'white', x = '(w-text_w)/2', from, to, line = 1.25 }) =>
  `drawtext=fontfile=${font}:textfile=${tf(s)}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:line_spacing=${Math.round(size * (line - 1))}` +
  (from !== undefined ? `:enable='between(t,${from.toFixed(2)},${to.toFixed(2)})'` : '')

// ---- 1. cards ------------------------------------------------------------------------------------------
function card(name, seconds, draws) {
  ff(['-f', 'lavfi', '-i', `color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${seconds}`, '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`,
    '-vf', [...draws, `fade=t=in:d=0.4,fade=t=out:st=${seconds - 0.4}:d=0.4`].join(','), '-t', String(seconds),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-shortest', `${D}parts/${name}.mp4`])
}
card('a_intro', 5.5, [
  text('Duet', { size: 150, y: 300, font: BOLD, color: GREEN }),
  text('Talk with Claude, hands-free, on Even Realities G2', { size: 54, y: 500 }),
  text('Ask, follow up, act on your calendar, mail and texts. Nothing is sent until you say yes.', { size: 34, y: 600, color: DIM }),
  text('Heads Up  ·  Track 04: AI Assistants & Work', { size: 30, y: 880, color: DIM }),
])
card('c_how', 11, [
  text('How it works', { size: 64, y: 120, font: BOLD, color: GREEN }),
  text([
    '1.  The G2 microphone streams to the Duet app. Voice detection learns the room,',
    '     so fans, traffic and clatter don\'t hold the mic open.',
    '2.  Your words go to speech-to-text (Whisper, about 0.4 s).',
    '3.  Claude (claude-opus-5-5) answers, with web search, Google Calendar, Gmail',
    '     and Messages (iMessage / SMS) as tools.',
    '4.  The answer streams onto the lens, and the mic is already open for your reply.',
    '',
    'Reads run at once. Every send, reply or calendar change shows the exact draft on the lens',
    'and waits for your spoken "yes" (or a tap). Say a change and Claude redrafts.',
    'Audio and conversations are never written to disk.',
].join('\n'), { size: 36, y: 270, x: 170, line: 1.55 }),
])
card('d_end', 6, [
  text('Duet', { size: 120, y: 330, font: BOLD, color: GREEN }),
  text('github.com/rickndanger-ctrl/duet', { size: 52, y: 520 }),
  text('Open source (MIT)  ·  Even Hub app + small Node server', { size: 34, y: 620, color: DIM }),
])

// ---- 2. the recorded session -------------------------------------------------------------------------
const START = Math.max(0, (tl.scenes[0]?.start ?? 0) - 300) // ms into the recording
const END = tl.end
const S = ms => (ms - START) / 1000
// Lens frames as a concat list (each frame shown until the next one).
const frames = tl.frames.filter(f => f.t <= END)
let first = frames.findLastIndex(f => f.t <= START); if (first < 0) first = 0
const list = []
for (let i = first; i < frames.length; i++) {
  const a = Math.max(frames[i].t, START), b = i + 1 < frames.length ? frames[i + 1].t : END
  if (b <= a) continue
  list.push(`file '${D}${frames[i].f}'`, `duration ${((b - a) / 1000).toFixed(3)}`)
}
list.push(`file '${D}${frames.at(-1).f}'`)
writeFileSync(D + 'frames.txt', list.join('\n') + '\n')
const total = S(END)

const CAPTIONS = {
  glance: 'Glance up: the time and date while Duet is paused',
  ask: 'Say "Hey Duet" and ask. No phone, no buttons.',
  follow: 'Just keep talking: the mic is already open for your reply',
  email: 'Nothing is sent until you say yes. Say a change and it redrafts.',
  texts: 'Your texts: hear what came in, reply by voice',
  calendar: 'Move a meeting. Say "pause" when you\'re done.',
  noise: 'A fan running: Duet still hears when you stop talking',
}
const SAID = Object.fromEntries(readFileSync(D + 'lines.txt', 'utf8').trim().split('\n').map(l => l.split('|')))
SAID.maya = "Text Maya back. Sure, I'll grab some on the way home."
const draws = []
tl.scenes.forEach((s, i) => {
  const a = S(s.start), b = i + 1 < tl.scenes.length ? S(tl.scenes[i + 1].start) : total
  draws.push(text(CAPTIONS[s.title] || s.title, { size: 46, y: 70, font: BOLD, from: Math.max(0, a), to: b - 0.05 }))
})
for (const c of tl.clips) {
  const a = S(c.start), b = a + dur(c.file) + 0.6
  draws.push(text(`You:  "${SAID[c.name] || c.name}"`, { size: 38, y: 948, color: '0xdfe8e1', from: a, to: b }))
}
if (tl.fan) draws.push(text('(fan noise playing into the mic)', { size: 30, y: 1000, color: DIM, from: S(tl.fan.start), to: S(tl.fan.stop) }))
draws.push(text('Real Duet app in the Even Hub simulator  ·  live Claude + speech-to-text  ·  demo account data', { size: 24, y: 1040, color: '0x6f8174' }))

// Audio: each clip at its time, the fan between its start and stop.
const ains = [], afil = []
tl.clips.forEach((c, i) => { ains.push('-i', c.file); afil.push(`[${i + 1}:a]aresample=48000,adelay=${Math.round(S(c.start) * 1000)}:all=1[c${i}]`) })
let mixIn = tl.clips.map((_, i) => `[c${i}]`).join('')
let nIn = tl.clips.length
if (tl.fan) {
  ains.push('-i', tl.fan.file)
  const k = tl.clips.length + 1
  afil.push(`[${k}:a]aresample=48000,atrim=0:${((tl.fan.stop - tl.fan.start) / 1000).toFixed(2)},afade=t=out:st=${((tl.fan.stop - tl.fan.start) / 1000 - 0.5).toFixed(2)}:d=0.5,adelay=${Math.round(S(tl.fan.start) * 1000)}:all=1[fan]`)
  mixIn += '[fan]'; nIn++
}
afil.push(`${mixIn}amix=inputs=${nIn}:normalize=0:duration=longest,apad,atrim=0:${total.toFixed(2)},pan=stereo|c0=c0|c1=c0,volume=1.4,alimiter=limit=0.89:level=false[aout]`)

const LW = 1440, LH = 720, LX = (W - LW) / 2, LY = 175
const vfil = [
  `[0:v]format=rgba,scale=${LW}:${LH}:flags=lanczos[lens]`,
  `color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${total.toFixed(2)}[bg]`,
  `[bg]drawbox=x=${LX - 14}:y=${LY - 14}:w=${LW + 28}:h=${LH + 28}:color=0x1f2a22:t=fill,drawbox=x=${LX - 2}:y=${LY - 2}:w=${LW + 4}:h=${LH + 4}:color=0x000000:t=fill[frame]`,
  `[frame][lens]overlay=${LX}:${LY}:shortest=1,fps=${FPS},${draws.join(',')},fade=t=in:d=0.4,fade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5[vout]`,
]
ff(['-f', 'concat', '-safe', '0', '-i', D + 'frames.txt', ...ains,
  '-filter_complex', [...vfil, ...afil].join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(2),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', `${D}parts/b_session.mp4`])

// ---- 3. join -------------------------------------------------------------------------------------------
writeFileSync(D + 'parts.txt', ['a_intro', 'b_session', 'c_how', 'd_end'].map(n => `file '${D}parts/${n}.mp4'`).join('\n') + '\n')
ff(['-f', 'concat', '-safe', '0', '-i', D + 'parts.txt', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', OUT])
console.log(`${OUT}  ${dur(OUT).toFixed(1)} s`)
