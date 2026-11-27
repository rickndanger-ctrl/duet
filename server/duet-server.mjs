#!/usr/bin/env node
// Duet server: the glasses app's only backend. Two calls, both behind one bearer token.
//
//   POST /v1/stt   body: 16 kHz s16le mono PCM   query: ?mode=wake|talk   -> {text}
//   POST /v1/chat     body: {conversation, text, context:{time,tz,place}}  -> {turn}
//   GET  /v1/turn/:id?after=n   long-poll (up to 20 s) -> {events, next, done}
//        events: {"t":"delta","text"} {"t":"status","text"} {"t":"confirm","id","verb","prompt"} {"t":"done"} {"t":"error","message"}
//   POST /v1/turn/:id/cancel    the wearer talked over the answer or left
//   POST /v1/confirm  body: {id, ok}   the wearer's yes/no to a "confirm" event (send an email, move a meeting...)
//   GET  /health   -> {ok:true}
//
// Keys come from the environment or files in DUET_CONFIG (default ~/.config/duet):
//   ANTHROPIC_API_KEY | anthropic.key,  GROQ_API_KEY | groq.key,  DUET_TOKEN | token
// Audio and conversation text are never written to disk or logs.
import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { loadGoogle } from './google.mjs'
import { GOOGLE_TOOLS, READ_TOOLS, invalidInput, prepareWrite, runRead, fakeGoogle } from './tools.mjs'

const CONFIG = process.env.DUET_CONFIG || path.join(os.homedir(), '.config', 'duet')
const secret = (env, file) => process.env[env] || (() => { try { return readFileSync(path.join(CONFIG, file), 'utf8').trim() } catch { return '' } })()
const PORT = Number(process.env.PORT || 5191)
const HOST = process.env.HOST || '127.0.0.1'
const TOKEN = secret('DUET_TOKEN', 'token')
const GROQ_KEY = secret('GROQ_API_KEY', 'groq.key')
const ANTHROPIC_KEY = secret('ANTHROPIC_API_KEY', 'anthropic.key')
const MODEL = process.env.DUET_MODEL || 'claude-opus-5-5'
const EFFORT = process.env.DUET_EFFORT || 'low'
/** DUET_FAKE=1: canned transcripts and answers, for the simulator and tests (no keys needed). */
const FAKE = process.env.DUET_FAKE === '1'

/** The built glasses app, served at /app/ so the phone can load it straight from here (dev QR). */
const APP_DIR = process.env.DUET_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'dist')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }

async function serveApp(res, rel) {
  try {
    const file = path.resolve(APP_DIR, '.' + (rel === '/' || rel === '' ? '/index.html' : decodeURIComponent(rel)))
    if (!file.startsWith(APP_DIR + path.sep) || !statSync(file).isFile()) throw new Error('missing')
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end('Not found') }
}

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null
const google = FAKE ? fakeGoogle : loadGoogle(CONFIG)

export const SYSTEM = `You are Duet, a voice assistant that lives in the wearer's Even Realities G2 smart glasses.
The wearer speaks to you; their words reach you through speech-to-text, so expect small transcription errors and read for intent.
Your reply is shown as text on a small monochrome display, about 50 characters by 8 lines, and the wearer reads it while walking, cooking or talking to people.

How to answer:
- Lead with the answer itself. Usually 1-3 short sentences, under 50 words. Go longer only when asked for steps, a list or detail; then use short lines.
- Plain text only: no markdown, no headings, no bullets with asterisks, no emoji, no tables. For lists use "1." style lines or "- ".
- This is a spoken back-and-forth: the wearer will simply answer you by voice. Ask a short follow-up question only when it truly helps.
- Use web search for anything current (news, weather, scores, prices, opening hours, recent facts). Don't announce that you are searching.
- If you're unsure what was said, say what you heard and ask.
- Each message ends with the wearer's current time, time zone and rough location in parentheses. Use them; don't repeat them back.`

const GOOGLE_SYSTEM = `

You can read and act on the wearer's Google Calendar and Gmail with tools.
- Reads (calendar_events, gmail_search, gmail_read): just do them. "What's next?" means the next event from now; "my inbox" means unread mail in the inbox.
- Actions (gmail_reply, gmail_send, calendar_create_event, calendar_update_event): call the tool directly. The glasses show the wearer the exact draft and ask "yes or no" themselves, so never ask "shall I?" first and never ask them to dictate long text. Write drafts in the wearer's voice: short, warm, no sign-off.
- After an action, confirm in a few words ("Sent." / "Moved to 4:00 PM."). If they said no, say it wasn't sent and offer to change it.
- For mail, give sender first name, subject gist and what they want, in one line each. Never read out long emails; summarize.`

const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }

function wav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

const FAKE_TALK = ['Yes, send it.', 'Tell me a fun fact about octopuses.']
let fakeTalk = 0
const TALK_HINT = 'Duet, the assistant in my glasses.'

/** Speech to text (Groq Whisper). */
export async function transcribe(pcm, mode = 'talk') {
  if (FAKE) return mode === 'wake' ? 'Hey Duet, any email from Sam?' : FAKE_TALK[fakeTalk++ % FAKE_TALK.length]
  if (!GROQ_KEY) throw new Error('speech-to-text key missing on the server')
  const form = new FormData()
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'json')
  form.append('language', 'en')
  form.append('temperature', '0')
  // No hint in wake mode: a hint containing "Hey Duet" makes Whisper write it for plain noise.
  if (mode === 'talk') form.append('prompt', TALK_HINT)
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form, signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`speech service said ${res.status}`)
  const text = String((await res.json()).text || '').trim()
  // On noise Whisper sometimes just repeats its hint back.
  return text.replace(/[^a-z ]/gi, '').trim().toLowerCase() === TALK_HINT.replace(/[^a-z ]/gi, '').trim().toLowerCase() ? '' : text
}

// ---- conversations ----------------------------------------------------------------
// The server keeps each conversation's full message list (tool calls included), so "reply to that one"
// still knows which email. Kept in memory only, dropped after 30 minutes of quiet.
const CONVERSATION_TTL_MS = 30 * 60_000
const conversations = new Map()
function conversation(id) {
  const key = typeof id === 'string' && /^[\w-]{8,64}$/.test(id) ? id : ''
  for (const [k, c] of conversations) if (Date.now() - c.at > CONVERSATION_TTL_MS) conversations.delete(k)
  if (!key) return { messages: [], at: Date.now(), lock: Promise.resolve() }
  if (!conversations.has(key)) conversations.set(key, { messages: [], at: Date.now(), lock: Promise.resolve() })
  const c = conversations.get(key)
  c.at = Date.now()
  return c
}

/** Confirmations waiting for the wearer: id -> resolve(boolean). */
const pending = new Map()
function askWearer(event, verb, prompt, signal) {
  const id = randomUUID()
  event({ t: 'confirm', id, verb, prompt })
  return new Promise(resolve => {
    const done = ok => { if (!pending.has(id)) return; pending.delete(id); clearTimeout(timer); resolve(ok) }
    const timer = setTimeout(() => done(false), 60_000)
    signal.addEventListener('abort', () => done(false), { once: true })
    pending.set(id, done)
  })
}

function contextLine(ctx) {
  const parts = []
  if (ctx?.time) parts.push(`now ${String(ctx.time).slice(0, 80)}`)
  if (ctx?.tz) parts.push(`time zone ${String(ctx.tz).slice(0, 40)}`)
  if (ctx?.place) parts.push(`location ${String(ctx.place).slice(0, 80)}`)
  return parts.length ? `\n\n(${parts.join('; ')})` : ''
}

const STATUS = { calendar_events: 'checking your calendar', gmail_search: 'checking your mail', gmail_read: 'reading the email',
  calendar_create_event: 'preparing the event', calendar_update_event: 'preparing the change', gmail_reply: 'drafting the reply', gmail_send: 'drafting the email' }

async function runTool(use, ctx, event, signal) {
  const result = (content, isError = false) => ({ type: 'tool_result', tool_use_id: use.id, content: typeof content === 'string' ? content : JSON.stringify(content), ...(isError ? { is_error: true } : {}) })
  const bad = invalidInput(use.name, use.input)
  if (bad) return result(`Invalid input: ${bad}`, true)
  event({ t: 'status', text: STATUS[use.name] || 'working' })
  try {
    if (READ_TOOLS.has(use.name)) return result(await runRead(google, use.name, use.input))
    const write = await prepareWrite(google, use.name, use.input, ctx)
    const ok = await askWearer(event, write.verb, write.prompt, signal)
    console.log(`confirm ${use.name}: ${ok ? 'yes' : 'no'}`)
    if (!ok) return result('The wearer said no (or did not answer). Nothing was sent or changed. Say so in a few words and ask if they want to change it.')
    event({ t: 'status', text: write.verb === 'Send' ? 'sending' : 'saving' })
    return result({ done: true, ...(await write.run()) })
  } catch (error) {
    console.log(`tool ${use.name} failed: ${error?.message || error}`)
    return result(`Failed: ${String(error?.message || error).slice(0, 300)}`, true)
  }
}

/** One wearer turn: Claude streams text, may use tools (writes wait for a yes on the lens), until it ends its turn. */
async function runTurn(conv, text, ctx, event, signal) {
  conv.messages.push({ role: 'user', content: text.slice(0, 4000) + contextLine(ctx) })
  let wrote = false
  const tools = google ? [WEB_SEARCH, ...GOOGLE_TOOLS] : [WEB_SEARCH]
  try {
    for (let step = 0; step < 10; step++) {
      const stream = anthropic.beta.messages.stream({
        model: MODEL,
        max_tokens: 4096,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: EFFORT },
        system: [{ type: 'text', text: google ? SYSTEM + GOOGLE_SYSTEM : SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: conv.messages,
      }, { signal })
      stream.on('streamEvent', ev => {
        if (ev.type !== 'content_block_start') return
        if (ev.content_block?.type === 'server_tool_use') event({ t: 'status', text: 'searching the web' })
        if (ev.content_block?.type === 'text') { if (wrote) event({ t: 'delta', text: '\n' }) }
      })
      stream.on('text', t => { if (!t) return; wrote = true; event({ t: 'delta', text: t }) })
      const msg = await stream.finalMessage()
      conv.messages.push({ role: 'assistant', content: msg.content })
      if (msg.stop_reason === 'pause_turn') continue
      if (msg.stop_reason === 'refusal') { event({ t: 'delta', text: (wrote ? '\n' : '') + "Sorry, I can't help with that one." }); break }
      const uses = msg.content.filter(b => b.type === 'tool_use')
      if (msg.stop_reason !== 'tool_use' || !uses.length) break
      const results = []
      for (const use of uses) results.push(await runTool(use, ctx, event, signal)) // one at a time: each write is its own yes/no
      conv.messages.push({ role: 'user', content: results })
      if (signal.aborted) break
    }
  } finally {
    // Interrupted (the wearer talked over it, or left): close the turn so the next one starts cleanly.
    if (conv.messages.at(-1)?.role === 'user') {
      conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: '(Interrupted by the wearer.)' }] })
    }
  }
}

/** DUET_FAKE: a scripted turn that exercises streaming and the confirm step without any keys. */
async function fakeTurn(conv, text, ctx, event, signal) {
  const say = async s => { for (const w of s.split(' ')) { if (signal.aborted) return; event({ t: 'delta', text: w + ' ' }); await new Promise(r => setTimeout(r, 35)) } }
  conv.messages.push({ role: 'user', content: text })
  if (/email|reply|sam|lunch/i.test(text)) {
    event({ t: 'status', text: 'checking your mail' })
    await new Promise(r => setTimeout(r, 400))
    const ok = await askWearer(event, 'Send', 'Reply to Sam Lee\nRe: Lunch Friday?\n"Yes! See you at noon."', signal)
    await say(ok ? 'Sent. Sam knows you\'ll be there at noon.' : 'Okay, I didn\'t send it. Want to change the reply?')
  } else if (/octopus/i.test(text)) {
    await say('Here are five octopus facts:\n1. Three hearts: two for the gills, one for the body.\n2. Blue blood, thanks to copper-based hemocyanin.\n3. Two thirds of their neurons live in their arms.\n4. They can change color and skin texture in a fraction of a second.\n5. Most species live only one to two years.\nWant one about squid next?')
  } else {
    await say('I can answer questions, check the web, and read or act on your calendar and email. Try: "any email from Sam?"')
  }
  conv.messages.push({ role: 'assistant', content: 'ok' })
}

// ---- turns (long-poll) ---------------------------------------------------------------
// POST /v1/chat starts a turn and answers {turn} at once; the app then long-polls GET /v1/turn/:id?after=n.
// (Webviews buffer small streamed chunks, so a streamed response showed nothing until it ended.)
const turns = new Map()
const TURN_TTL_MS = 5 * 60_000
const POLL_WAIT_MS = 20_000

function startTurn(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const conv = conversation(body.conversation)
  const id = randomUUID()
  const turn = { events: [], done: false, waiters: new Set(), abort: new AbortController(), at: Date.now() }
  turns.set(id, turn)
  for (const [k, t] of turns) if (t.done && Date.now() - t.at > TURN_TTL_MS) turns.delete(k)
  const event = obj => {
    // Text deltas that arrive between polls are merged, so one poll carries one chunk of text.
    const last = turn.events.at(-1)
    if (obj.t === 'delta' && last?.t === 'delta' && !last.sent) last.text += obj.text
    else turn.events.push(obj)
    for (const wake of turn.waiters) wake()
  }
  void (async () => {
    const previous = conv.lock // an interrupted turn finishes closing before the next one starts
    let release
    conv.lock = new Promise(r => { release = r })
    await previous
    const started = Date.now()
    try {
      await (FAKE ? fakeTurn : runTurn)(conv, text, body.context, event, turn.abort.signal)
      console.log(`turn ok msgs=${conv.messages.length} ${Date.now() - started}ms${turn.abort.signal.aborted ? ' (cancelled)' : ''}`)
      event({ t: 'done' })
    } catch (error) {
      if (!turn.abort.signal.aborted) console.log(`turn failed: ${error?.status || ''} ${error?.message || error}`)
      event(turn.abort.signal.aborted ? { t: 'done' } : { t: 'error', message: error instanceof Anthropic.RateLimitError ? 'Claude is busy, try again in a moment.' : 'Claude did not answer. Try again.' })
    } finally {
      turn.done = true
      turn.at = Date.now()
      release()
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
  const p = url.pathname.replace(/^\/duet(?=\/|$)/, '') || '/' // also served under a /duet path prefix
  if (req.method === 'GET' && (p === '/app' || p.startsWith('/app/'))) {
    if (p === '/app') { res.writeHead(302, { Location: 'app/' }); return res.end() }
    return serveApp(res, p.slice(4))
  }
  if (p === '/health') return send(res, 200, { ok: true, claude: Boolean(anthropic) || FAKE, stt: Boolean(GROQ_KEY) || FAKE, model: MODEL, google: Boolean(google) })
  if (!FAKE && (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`)) return send(res, 401, { error: 'unauthorized' })
  try {
    if (req.method === 'POST' && p === '/v1/stt') {
      const pcm = await readBody(req, 16000 * 2 * 60) // a minute at most
      if (pcm.length < 3200) return send(res, 200, { text: '' }) // under 0.1 s: nothing said
      const t0 = Date.now()
      const text = await transcribe(pcm, url.searchParams.get('mode') === 'wake' ? 'wake' : 'talk')
      console.log(`stt ${url.searchParams.get('mode') || 'talk'} ${(pcm.length / 32000).toFixed(1)}s audio in ${Date.now() - t0}ms`)
      return send(res, 200, { text })
    }
    if (req.method === 'POST' && p === '/v1/confirm') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
      const done = pending.get(String(body.id))
      if (!done) return send(res, 404, { error: 'nothing waiting' })
      done(body.ok === true)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p === '/v1/chat') {
      const body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}')
      if (typeof body.text !== 'string' || !body.text.trim()) return send(res, 400, { error: 'text required' })
      if (!FAKE && !anthropic) return send(res, 503, { error: 'Claude key missing on the server' })
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
  server.listen(PORT, HOST, () => console.log(`duet server on http://${HOST}:${PORT} model=${MODEL} claude=${Boolean(anthropic)} stt=${Boolean(GROQ_KEY)} google=${Boolean(google)}${FAKE ? ' FAKE' : ''}`))
}
