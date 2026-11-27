#!/usr/bin/env node
// Duet server: the glasses app's only backend. Two calls, both behind one bearer token.
//
//   POST /v1/stt   body: 16 kHz s16le mono PCM   query: ?mode=wake|talk   -> {text}
//   POST /v1/chat  body: {messages:[{role,content}]}                     -> text/event-stream
//        events: {"t":"delta","text":"..."}  {"t":"search","q":"..."}  {"t":"done"}  {"t":"error","message":"..."}
//   GET  /health   -> {ok:true}
//
// Keys come from the environment or files in DUET_CONFIG (default ~/.config/duet):
//   ANTHROPIC_API_KEY | anthropic.key,  GROQ_API_KEY | groq.key,  DUET_TOKEN | token
// Audio and conversation text are never written to disk or logs.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

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

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null

export const SYSTEM = `You are Duet, a voice assistant that lives in the wearer's Even Realities G2 smart glasses.
The wearer speaks to you; their words reach you through speech-to-text, so expect small transcription errors and read for intent.
Your reply is shown as text on a small monochrome display, about 50 characters by 8 lines, and the wearer reads it while walking, cooking or talking to people.

How to answer:
- Lead with the answer itself. Usually 1-3 short sentences, under 50 words. Go longer only when asked for steps, a list or detail; then use short lines.
- Plain text only: no markdown, no headings, no bullets with asterisks, no emoji, no tables. For lists use "1." style lines or "- ".
- This is a spoken back-and-forth: the wearer will simply answer you by voice. Ask a short follow-up question only when it truly helps.
- Use web search for anything current (news, weather, scores, prices, opening hours, recent facts). Don't announce that you are searching.
- If you're unsure what was said, say what you heard and ask.`

const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }

function wav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

const TALK_HINT = 'Duet, the assistant in my glasses.'

/** Speech to text (Groq Whisper). */
export async function transcribe(pcm, mode = 'talk') {
  if (FAKE) return mode === 'wake' ? 'Hey Duet, what can you do?' : 'Tell me a fun fact about octopuses.'
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

/** Only well-formed user/assistant text turns, newest 40, starting with a user turn. */
export function cleanMessages(input) {
  const list = Array.isArray(input) ? input : []
  const out = list
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-40)
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

function localContext(ctx) {
  const parts = []
  if (ctx?.time) parts.push(`Wearer's local time: ${String(ctx.time).slice(0, 60)}.`)
  if (ctx?.place) parts.push(`Wearer's approximate location: ${String(ctx.place).slice(0, 80)}.`)
  return parts.join(' ')
}

async function chat(req, res, body) {
  const messages = cleanMessages(body.messages)
  if (!messages.length || messages.at(-1).role !== 'user') return send(res, 400, { error: 'needs a user turn last' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  const event = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  const started = Date.now()
  let first = 0
  try {
    if (FAKE || !anthropic) {
      if (!FAKE) throw new Error('Claude key missing on the server')
      const long = /octopus/i.test(messages.at(-1).content)
      const words = (long
        ? 'Here are five octopus facts:\n1. Three hearts: two for the gills, one for the body.\n2. Blue blood, thanks to copper-based hemocyanin.\n3. Two thirds of their neurons live in their arms.\n4. They can change color and skin texture in a fraction of a second.\n5. Most species live only one to two years.\nWant one about squid next?'
        : 'Octopuses have three hearts and blue blood. Two hearts pump blood to the gills, one to the rest of the body. Want another one?').split(' ')
      for (const w of words) { if (abort.signal.aborted) return; event({ t: 'delta', text: w + ' ' }); await new Promise(r => setTimeout(r, 40)) }
      event({ t: 'done' })
      return res.end()
    }
    const context = localContext(body.context)
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [WEB_SEARCH],
      messages: context ? [...messages.slice(0, -1), { role: 'user', content: `${messages.at(-1).content}\n\n(${context})` }] : messages,
    }, { signal: abort.signal })
    stream.on('streamEvent', ev => {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') event({ t: 'search' })
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && first) event({ t: 'delta', text: '\n' })
    })
    stream.on('text', text => { if (!first) first = Date.now(); event({ t: 'delta', text }) })
    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal') event({ t: 'delta', text: "Sorry, I can't help with that one." })
    console.log(`chat ok turns=${messages.length} first=${first ? first - started : -1}ms total=${Date.now() - started}ms stop=${final.stop_reason} model=${final.model}`)
    event({ t: 'done' })
  } catch (error) {
    if (abort.signal.aborted) return
    console.log(`chat failed: ${error?.status || ''} ${error?.message || error}`)
    event({ t: 'error', message: error instanceof Anthropic.RateLimitError ? 'Claude is busy, try again in a moment.' : 'Claude did not answer. Try again.' })
  }
  res.end()
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
  const p = url.pathname.replace(/^\/duet(?=\/)/, '') // also served under a /duet path prefix
  if (p === '/health') return send(res, 200, { ok: true, claude: Boolean(anthropic) || FAKE, stt: Boolean(GROQ_KEY) || FAKE, model: MODEL })
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
    if (req.method === 'POST' && p === '/v1/chat') {
      const body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}')
      return await chat(req, res, body)
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    console.log(`request failed ${p}: ${error?.message || error}`)
    if (!res.headersSent) send(res, 500, { error: 'server error' })
    else res.end()
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => console.log(`duet server on http://${HOST}:${PORT} model=${MODEL} claude=${Boolean(anthropic)} stt=${Boolean(GROQ_KEY)}${FAKE ? ' FAKE' : ''}`))
}
