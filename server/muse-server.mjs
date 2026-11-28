#!/usr/bin/env node
// Hey Muse server (package com.piebird.duetmuse, once "Duet Muse"): the same API as duet-server.mjs (so the same glasses app works), but the answers come from
// Rick's Muse on a Mac, through the existing Muse relay (types into Muse's window and reads it back). It never
// changes the relay: it only uses the relay's own calls, the way other relay clients do.
//
//   POST /v1/stt   body: 16 kHz s16le mono PCM   query: ?mode=wake|talk   -> {text}      (Groq Whisper, like Duet)
//   POST /v1/chat     body: {conversation, text}  -> {turn}
//   GET  /v1/turn/:id?after=n   long-poll (up to 20 s) -> {events, next, done}
//        events: {"t":"delta","text"} {"t":"status","text"} {"t":"done"} {"t":"error","message"}
//   POST /v1/turn/:id/cancel    the wearer talked over the answer or left (Muse itself can't be stopped from here)
//   GET  /health   -> {ok, muse, stt}
//
// One turn: the relay's /selftest (is Muse's text box ready?), /ask, then /reply/:id while the relay is on it, then
// its read-only /latest until Muse's card says "Connected" again (see muse-reply.mjs: the relay alone would hand back
// the "Musa / is working" stub). Approvals happen in Muse's window; the lens says when Muse waits for one.
//
// Speech to text: Groq, plus an optional local whisper.cpp server (DUET_LOCAL_STT_URL) for the wake checks (see transcribe).
// Config in DUET_CONFIG (default ~/.config/duet-muse):  token (the app's password), groq.key, muse.json:
//   [{"name": "My Mac", "url": "https://<relay host>/muse", "tokenFile": "<file holding the relay token>"}, …]
// tried in order (a later one only when an earlier one isn't ready). Or one relay via DUET_MUSE_URL + DUET_MUSE_TOKEN_FILE.
// Audio and conversation text are never written to disk or logs.
import http from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readMuse, sameQuestion } from './muse-reply.mjs'

const home = p => String(p || '').replace(/^~(?=\/|$)/, os.homedir())
const CONFIG = home(process.env.DUET_CONFIG || '~/.config/duet-muse')
const fileText = file => { try { return readFileSync(home(file), 'utf8').trim() } catch { return '' } }
const secret = (env, file) => process.env[env] || fileText(path.join(CONFIG, file))
const PORT = Number(process.env.PORT || 5192)
const HOST = process.env.HOST || '127.0.0.1'
const TOKEN = secret('DUET_TOKEN', 'token')
const GROQ_KEY = secret('GROQ_API_KEY', 'groq.key')
/** Debugging a session: while the file DUET_CONFIG/debug exists, transcripts and questions are logged (delete it when
 *  done). Off by default: normally no speech or text is ever logged. */
const debugOn = () => existsSync(path.join(CONFIG, 'debug'))
/** DUET_FAKE=1: canned transcripts (no Groq key); the relay is still whatever muse.json / DUET_MUSE_URL says. */
const FAKE = process.env.DUET_FAKE === '1'
const GROQ_URL = process.env.DUET_GROQ_URL || 'https://api.groq.com/openai/v1/audio/transcriptions'
/** A local whisper.cpp server for speech to text, e.g. http://127.0.0.1:5194/inference (see transcribe). */
const LOCAL_STT = process.env.DUET_LOCAL_STT_URL || ''

function relays() {
  if (process.env.DUET_MUSE_URL) return [{ name: process.env.DUET_MUSE_NAME_LABEL || 'Muse', url: process.env.DUET_MUSE_URL, tokenFile: process.env.DUET_MUSE_TOKEN_FILE }]
  try { return JSON.parse(readFileSync(path.join(CONFIG, 'muse.json'), 'utf8')) } catch { return [] }
}
const MUSES = relays().filter(m => m?.url).map(m => ({ name: String(m.name || 'Muse'), url: String(m.url).replace(/\/+$/, ''), token: process.env.DUET_MUSE_TOKEN || fileText(m.tokenFile) }))

/** A line typed after each question, so Muse writes for the lens. DUET_MUSE_NOTE='' turns it off. */
const NOTE = process.env.DUET_MUSE_NOTE ?? '(Answer for my glasses: short, plain text.)'
const POLL_REPLY_MS = Number(process.env.DUET_MUSE_POLL_MS || 700)
/** /latest makes the relay read Muse's whole window (~0.7 s on the Mac): a little slower. */
const POLL_LATEST_MS = Number(process.env.DUET_MUSE_LATEST_MS || 900)
/** "Connected" and the same answer on this many reads in a row = done. */
const STABLE_READS = 2
/** Without Muse's card (Muse 14.1 shows none): after the relay's own ~1 s check, the same answer this many reads in a row = done.
 *  (Muse 14.1 puts its answer in the window all at once.) */
const STABLE_READS_NO_CARD = 2
/** How long one turn may wait for Muse (an approval in Muse's window can take a while). */
const TURN_MAX_MS = Number(process.env.DUET_MUSE_TURN_MAX_MS || 10 * 60_000)

/** The built glasses app (the Muse build), served at /app/ so the phone can load it straight from here (dev QR). */
const APP_DIR = process.env.DUET_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'dist-muse')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' }

async function serveApp(res, rel) {
  try {
    const file = path.resolve(APP_DIR, '.' + (rel === '/' || rel === '' ? '/index.html' : decodeURIComponent(rel)))
    if (!file.startsWith(APP_DIR + path.sep) || !statSync(file).isFile()) throw new Error('missing')
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end('Not found') }
}

// ---- speech to text (the same as duet-server.mjs) ---------------------------------------------------------------
function wav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

const FAKE_TALK = ['What is a good name for a cat?']
let fakeTalk = 0
const TALK_HINT = 'Muse, the assistant in my glasses.'

/** Groq Whisper (the same as Duet). */
async function groq(pcm, mode) {
  if (!GROQ_KEY) throw new Error('speech-to-text key missing on the server')
  const form = new FormData()
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'json')
  form.append('language', 'en')
  form.append('temperature', '0')
  if (mode === 'talk') form.append('prompt', TALK_HINT)
  const res = await fetch(GROQ_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form, signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`speech service said ${res.status}`)
  const text = String((await res.json()).text || '').trim()
  return text.replace(/[^a-z ]/gi, '').trim().toLowerCase() === TALK_HINT.replace(/[^a-z ]/gi, '').trim().toLowerCase() ? '' : text
}

/** whisper.cpp's whisper-server on this Mac (DUET_LOCAL_STT_URL): no quota, ~0.1 s. Its noise markers are dropped. */
async function local(pcm) {
  const form = new FormData()
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  const res = await fetch(LOCAL_STT, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`local speech-to-text said ${res.status}`)
  return String((await res.json()).text || '').replace(/[♪♫]|\[[^\]]*\]|\((?:music|silence|noise|blank_audio)[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Speech to text. Groq's free tier allows 2000 transcriptions a day for the whole account (shared by every app using the same key),
 * and listening for "Hey Muse" sends every phrase heard in the room. So with a local whisper.cpp server set up, the wake
 * checks run there; what you say to Muse goes to Groq (more accurate), and to the local one when Groq refuses (429) or fails.
 * Returns { text, via }.
 */
export async function transcribe(pcm, mode = 'talk') {
  if (FAKE) return { text: mode === 'wake' ? 'Hey Muse, what is two plus two?' : FAKE_TALK[fakeTalk++ % FAKE_TALK.length], via: 'fake' }
  if (LOCAL_STT && mode === 'wake') {
    try { return { text: await local(pcm), via: 'local' } } catch (error) { console.log(`stt local failed (${error?.message || error}), using Groq`) }
  }
  try {
    return { text: await groq(pcm, mode), via: 'groq' }
  } catch (error) {
    if (!LOCAL_STT || mode === 'wake') throw error
    console.log(`stt groq failed (${error?.message || error}), using local`)
    return { text: await local(pcm), via: 'local' }
  }
}

// ---- Muse ---------------------------------------------------------------------------------------------------------
class MuseError extends Error {}
const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

async function relay(muse, p, { method = 'GET', body, timeout = 8000, signal } = {}) {
  const res = await fetch(muse.url + p, {
    method,
    headers: { ...(muse.token ? { Authorization: `Bearer ${muse.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  })
  if (res.status === 401) throw new MuseError('Muse relay: bad token')
  if (!res.ok) throw new Error(`${p.split('/')[1]} ${res.status}`)
  return res.json()
}

/** The relay failed before anything was typed into Muse: safe to try the next Muse. */
const notTyped = error => /Command failed|did not take focus|nothing typed|could not bring Muse|Shortcut Guide|Muse is not running|has no window/i.test(String(error))

/** Hands the question to the first Muse that is up and ready, from `start` on. */
async function askMuse(question, start, signal) {
  // Lens errors are short: the status line shows about 22 characters.
  let why = 'no Muse relay set up'
  for (let i = start; i < MUSES.length; i++) {
    const muse = MUSES[i]
    try {
      const health = await relay(muse, '/selftest', { signal })
      if (!health.museRunning) { why = "Muse isn't running"; console.log(`muse ${muse.name}: not running`); continue }
      // busy: the relay is on another question (another app, say); ours waits its turn there.
      if (!health.composer && !health.busy) { why = 'Muse box not ready'; console.log(`muse ${muse.name}: text box not ready`); continue }
      const r = await relay(muse, '/ask', { method: 'POST', body: { text: question }, timeout: 10_000, signal })
      return { index: i, muse, id: String(r.id), busy: Boolean(health.busy) }
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof MuseError) why = error.message
      else why = "can't reach Muse"
      console.log(`muse ${muse.name}: ${error instanceof MuseError ? 'token refused' : 'not reachable'}`)
    }
  }
  throw new MuseError(why)
}

const STATUS_OF_JOB = { queued: 'Muse is busy, queued', sending: 'typing to Muse', waiting: 'Muse is working' }

/**
 * Asks Muse one question and reads its answer (the text). Calls status() while Muse works (and when it waits for an
 * approval in its window). Muse's answer isn't streamed: its window text can change anywhere while it writes, and the
 * lens only takes text added at the end.
 */
async function readAnswer(text, status, signal) {
  const question = NOTE ? `${text.slice(0, 1500)} ${NOTE}` : text.slice(0, 1800)
  let job = await askMuse(question, 0, signal)
  const started = Date.now()
  if (job.busy) status(STATUS_OF_JOB.queued)
  let relayDone = false
  let tries = 0
  let last = null, stable = 0
  while (!signal.aborted) {
    if (Date.now() - started > TURN_MAX_MS) {
      return `Muse is still on it on ${job.muse.name}. Its answer will be in its window there.`
    }
    await sleep(relayDone ? POLL_LATEST_MS : POLL_REPLY_MS, signal)
    if (signal.aborted) throw new Error('stopped')
    let reply
    try {
      if (!relayDone) {
        const r = await relay(job.muse, `/reply/${job.id}`, { timeout: 6000, signal })
        if (r.status === 'error') {
          // Nothing was typed (Muse's text box didn't take focus, say): safe to ask again, once here, then the next Muse.
          if (notTyped(r.error) && tries < 2) {
            tries++
            const next = tries === 1 ? job.index : job.index + 1
            console.log(`muse ${job.muse.name}: send failed before typing, ${next === job.index ? 'trying again' : 'trying the next one'}`)
            if (next < MUSES.length) { await sleep(1500, signal); job = await askMuse(question, next, signal); continue }
          }
          console.log(`muse ${job.muse.name}: relay job failed${notTyped(r.error) ? ' before typing' : ''}`)
          throw new MuseError(notTyped(r.error) ? "Muse didn't type it" : /did not appear/i.test(r.error) ? "Muse didn't take it" : 'Muse relay failed')
        }
        if (r.status === 'queued' || r.status === 'sending') { status(STATUS_OF_JOB[r.status]); continue }
        // waiting: the relay reads Muse for us. done/timeout: the relay stopped reading (maybe at the stub); read on ourselves.
        if (r.status === 'done' || r.status === 'timeout') relayDone = true
        reply = r.reply
      } else {
        const latest = await relay(job.muse, '/latest', { timeout: 8000, signal })
        if (!sameQuestion(latest.question, question)) {
          // Someone asked Muse something after us: our answer is no longer the newest. Use what we last saw.
          if (last?.answer) return last.answer
          throw new MuseError('Muse moved on')
        }
        reply = latest.reply
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof MuseError) throw error
      console.log(`muse ${job.muse.name}: read failed (${error?.message || error}), retrying`)
      continue
    }
    const seen = readMuse(reply)
    if (seen.approval) status(`approve it on ${job.muse.name}`)
    else if (!seen.idle) status(seen.answer ? 'Muse is writing' : 'Muse is working')
    stable = seen.answer && last && seen.answer === last.answer && seen.idle === last.idle ? stable + 1 : 0
    last = seen
    const done = seen.card ? seen.idle && seen.answer && stable >= STABLE_READS - 1
      : relayDone && seen.answer && stable >= STABLE_READS_NO_CARD - 1
    if (done) {
      console.log(`muse ${job.muse.name}: answer in ${Date.now() - started}ms (${seen.answer.length} chars)`)
      return seen.answer
    }
  }
  throw new Error('stopped')
}


/** Per conversation: the last thing handed to Muse (the wearer's words), when, and its answer (a promise). */
const asked = new Map()
/** An add-on within this long of the question it extends is sent as a follow-up (see museTurn). */
const ADD_ON_MS = 2 * 60_000

/** The words added to `before` ("…recipe?" → "…recipe? And the pecan one."), or '' when `after` doesn't extend it. */
export function addedTo(before, after) {
  const b = String(before || '').trim(), a = String(after || '').trim()
  if (!b || a.length <= b.length || !a.startsWith(b)) return ''
  return a.slice(b.length).trim()
}

/** Resolves with the promise's value, or with undefined once `signal` aborts (the promise keeps going). */
const unlessStopped = (promise, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return resolve(undefined)
  const stop = () => resolve(undefined)
  signal.addEventListener('abort', stop, { once: true })
  promise.then(v => { signal.removeEventListener('abort', stop); resolve(v) }, e => { signal.removeEventListener('abort', stop); reject(e) })
})

/**
 * One wearer turn with Muse.
 *
 * Duet joins what you say right after a pause to what you said before it, and asks again with the whole thing. Claude
 * just drops the first answer, but Muse can't take back a question already typed into its window: it answered both,
 * one after the other, and you waited for both. So here a question that extends the previous one (same conversation,
 * same words plus more) sends only the added words, as a follow-up, and the lens shows Muse's answer to the first part
 * and then to the rest. A question's answer is read on even when the wearer's turn is cancelled, for this.
 */
async function museTurn(text, conversation, event, signal) {
  let lastStatus = ''
  const status = s => { if (!signal.aborted && s && s !== lastStatus) { lastStatus = s; event({ t: 'status', text: s }) } }
  // Reading an answer outlives the turn (see above), up to the usual limit.
  const reading = () => AbortSignal.timeout(TURN_MAX_MS + 60_000)
  const prev = conversation ? asked.get(conversation) : undefined
  const extra = prev && Date.now() - prev.at < ADD_ON_MS ? addedTo(prev.text, text) : ''
  status(extra ? 'Muse is working' : 'asking Muse')
  if (extra) {
    const first = await unlessStopped(prev.answer.then(a => ({ ok: true, a }), () => ({ ok: false })), signal)
    if (!first) return
    // The first part never got an answer (its send failed): ask the whole thing instead.
    if (!first.ok) return museTurn(text, undefined, event, signal)
    if (first.a) event({ t: 'delta', text: first.a })
    const rest = readAnswer(extra, status, reading())
    asked.set(conversation, { text, at: Date.now(), answer: rest.then(r => (first.a ? `${first.a}\n\n${r}` : r)) })
    console.log('muse: follow-up to the question before')
    const r = await unlessStopped(rest, signal)
    if (r !== undefined) event({ t: 'delta', text: (first.a ? '\n\n' : '') + r })
    return
  }
  const answer = readAnswer(text, status, reading())
  answer.catch(() => {}) // a cancelled turn's failure is nobody's business
  if (conversation) asked.set(conversation, { text, at: Date.now(), answer })
  for (const [k, v] of asked) if (Date.now() - v.at > ADD_ON_MS) asked.delete(k)
  const a = await unlessStopped(answer, signal)
  if (a !== undefined) event({ t: 'delta', text: a })
}

// ---- turns (long-poll), as in duet-server.mjs ---------------------------------------------------------------------
const turns = new Map()
const TURN_TTL_MS = 5 * 60_000
const POLL_WAIT_MS = 20_000

function startTurn(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (debugOn()) console.log(`debug chat "${text.slice(0, 200)}"`)
  const id = randomUUID()
  const turn = { events: [], done: false, waiters: new Set(), abort: new AbortController(), at: Date.now() }
  turns.set(id, turn)
  for (const [k, t] of turns) if (t.done && Date.now() - t.at > TURN_TTL_MS) turns.delete(k)
  const event = obj => {
    const last = turn.events.at(-1)
    if (obj.t === 'delta' && last?.t === 'delta' && !last.sent) last.text += obj.text
    else turn.events.push(obj)
    for (const wake of turn.waiters) wake()
  }
  void (async () => {
    const started = Date.now()
    try {
      await museTurn(text, typeof body.conversation === 'string' && /^[\w-]{8,64}$/.test(body.conversation) ? body.conversation : '', event, turn.abort.signal)
      console.log(`turn ok ${Date.now() - started}ms${turn.abort.signal.aborted ? ' (cancelled)' : ''}`)
      event({ t: 'done' })
    } catch (error) {
      if (!turn.abort.signal.aborted) console.log(`turn failed: ${error?.message || error}`)
      event(turn.abort.signal.aborted ? { t: 'done' } : { t: 'error', message: error instanceof MuseError ? error.message : 'Muse did not answer. Try again.' })
    } finally {
      turn.done = true
      turn.at = Date.now()
      for (const wake of turn.waiters) wake()
    }
  })()
  return id
}

async function poll(res, id, after) {
  const turn = turns.get(id)
  if (!turn) return send(res, 404, { error: 'unknown turn' })
  if (turn.events.length <= after && !turn.done) {
    await new Promise(resolve => {
      const wake = () => { turn.waiters.delete(wake); clearTimeout(timer); resolve() }
      const timer = setTimeout(wake, POLL_WAIT_MS)
      turn.waiters.add(wake)
      res.on('close', wake)
    })
  }
  const events = turn.events.slice(after)
  for (const e of events) e.sent = true
  send(res, 200, { events: events.map(({ sent, ...e }) => e), next: after + events.length, done: turn.done && after + events.length >= turn.events.length })
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0
  req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
}

export const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const url = new URL(req.url, 'http://x')
  const p = url.pathname.replace(/^\/duet-muse(?=\/|$)/, '') || '/' // also served under a /duet-muse path prefix
  if (req.method === 'GET' && (p === '/app' || p.startsWith('/app/'))) {
    if (p === '/app') { res.writeHead(302, { Location: 'app/' }); return res.end() }
    return serveApp(res, p.slice(4))
  }
  if (p === '/health') return send(res, 200, { ok: true, muse: MUSES.length > 0, muses: MUSES.map(m => m.name), stt: Boolean(GROQ_KEY || LOCAL_STT) || FAKE, localStt: Boolean(LOCAL_STT) })
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' })
  try {
    if (req.method === 'POST' && p === '/v1/stt') {
      const pcm = await readBody(req, 16000 * 2 * 60)
      if (pcm.length < 3200) return send(res, 200, { text: '' })
      const t0 = Date.now()
      const { text, via } = await transcribe(pcm, url.searchParams.get('mode') === 'wake' ? 'wake' : 'talk')
      console.log(`stt ${url.searchParams.get('mode') || 'talk'} ${(pcm.length / 32000).toFixed(1)}s audio in ${Date.now() - t0}ms (${via})`)
      if (debugOn()) console.log(`debug stt "${text}"`)
      return send(res, 200, { text })
    }
    if (req.method === 'POST' && p === '/v1/confirm') return send(res, 404, { error: 'nothing waiting' }) // Muse approves in its own window
    if (req.method === 'POST' && p === '/v1/chat') {
      const body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}')
      if (typeof body.text !== 'string' || !body.text.trim()) return send(res, 400, { error: 'text required' })
      if (!MUSES.length) return send(res, 503, { error: 'no Muse relay set up' })
      return send(res, 200, { turn: startTurn(body) })
    }
    const turnPath = /^\/v1\/turn\/([\w-]{36})(\/cancel)?$/.exec(p)
    if (turnPath && req.method === 'GET' && !turnPath[2]) return await poll(res, turnPath[1], Math.max(0, Number(url.searchParams.get('after')) || 0))
    if (turnPath && req.method === 'POST' && turnPath[2]) {
      turns.get(turnPath[1])?.abort.abort()
      return send(res, 200, { ok: true })
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    console.log(`request failed ${p}: ${error?.message || error}`)
    if (!res.headersSent) send(res, 500, { error: 'server error' })
    else res.end()
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => console.log(`hey muse server on http://${HOST}:${PORT} muses=${MUSES.map(m => m.name).join(',') || 'none'} stt=${Boolean(GROQ_KEY)}${LOCAL_STT ? ' local-stt' : ''}${FAKE ? ' FAKE' : ''}`))
}
