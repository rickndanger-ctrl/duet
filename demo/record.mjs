// Records the demo: drives the real Duet app in the Even Hub simulator with spoken clips through a virtual mic,
// captures every lens frame from the simulator's screenshot API, and writes a timeline for the video render.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
const D = new URL('.', import.meta.url).pathname
const API = 'http://127.0.0.1:9898'
mkdirSync(D + 'frames', { recursive: true })
const t0 = Date.now(), now = () => Date.now() - t0
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tl = { frames: [], clips: [], fan: null, scenes: [], phases: [] }

// Lens frames: keep a frame only when the picture changed.
let last = null, grabbing = true, n = 0
;(async () => {
  while (grabbing) {
    const t = now()
    try {
      const b = Buffer.from(await (await fetch(API + '/api/screenshot/glasses')).arrayBuffer())
      if (!last || !b.equals(last)) { const f = `frames/${String(n++).padStart(5, '0')}.png`; writeFileSync(D + f, b); tl.frames.push({ t, f }); last = b }
    } catch {}
    await sleep(Math.max(0, 80 - (now() - t)))
  }
})()

// App phases from the simulator console.
let seenId = -1, phase = '', phaseLog = []
;(async () => {
  while (grabbing) {
    try {
      const r = await (await fetch(API + '/api/console')).json()
      for (const e of r.entries) if (e.id > seenId) {
        seenId = e.id
        const m = /^\[duet\] (.*)$/.exec(e.message)
        if (!m) continue
        const p = /^phase (\S+)/.exec(m[1])
        if (p) { phase = p[1]; phaseLog.push(phase); tl.phases.push({ t: now(), p: phase }) }
        console.log(`${(now() / 1000).toFixed(1).padStart(6)}  ${m[1]}`)
      }
    } catch {}
    await sleep(120)
  }
})()

async function waitPhase(want, ms = 40_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const i = phaseLog.findIndex(p => want.includes(p)); if (i >= 0) { const p = phaseLog[i]; phaseLog = phaseLog.slice(i + 1); return p } await sleep(60) }
  throw new Error(`timed out waiting for ${want} (now ${phase})`)
}
function play(name, file = `${D}lines/${name}.wav`) {
  phaseLog = []
  tl.clips.push({ name, start: now(), file })
  console.log(`${(now() / 1000).toFixed(1).padStart(6)}  >> ${name}`)
  return new Promise(r => spawn('paplay', ['--device=duet_voice', file]).on('exit', r))
}
const scene = title => { tl.scenes.push({ title, start: now() }); console.log(`\n== ${title}`) }
const hold = ms => sleep(ms)

try {
  await sleep(1500)
  scene('glance')
  await hold(3500)

  scene('ask')
  await play('next'); await waitPhase(['your-turn', 'error']); await hold(4500)

  scene('follow')
  await play('inbox'); await waitPhase(['your-turn', 'error']); await hold(4000)

  scene('email')
  await play('late'); await waitPhase(['confirm', 'your-turn', 'error']); await hold(2800)
  await play('change'); await waitPhase(['working']); await waitPhase(['confirm', 'your-turn', 'error']); await hold(2800)
  await play('yes_send'); await waitPhase(['your-turn', 'error']); await hold(2500)

  scene('texts')
  await play('texts'); await waitPhase(['your-turn', 'error']); await hold(4000)
  await play('maya'); await waitPhase(['confirm', 'your-turn', 'error']); await hold(2800)
  await play('yes'); await waitPhase(['your-turn', 'error']); await hold(2500)

  scene('calendar')
  await play('move'); await waitPhase(['confirm', 'your-turn', 'error']); await hold(2800)
  await play('yes2'); await waitPhase(['your-turn', 'error']); await hold(2500)
  await play('pause'); await waitPhase(['armed', 'asleep']); await hold(2000)

  scene('noise')
  const fan = spawn('paplay', ['--device=duet_voice', D + 'fan.wav'])
  tl.fan = { start: now(), stop: null, file: D + 'fan.wav' }
  await hold(3000)
  await play('rain'); await waitPhase(['your-turn', 'error']); await hold(4500)
  await play('pause'); await waitPhase(['armed', 'asleep']); await hold(1500)
  fan.kill(); tl.fan.stop = now()
  await hold(2500)
} catch (e) { console.log('!!', e.message) }
grabbing = false
tl.end = now()
await sleep(300)
writeFileSync(D + 'timeline.json', JSON.stringify(tl, null, 1))
console.log(`\ndone: ${tl.frames.length} frames, ${(tl.end / 1000).toFixed(1)} s`)
