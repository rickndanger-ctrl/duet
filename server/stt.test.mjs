// Duet's speech-to-text: Groq, and the optional local whisper-server (DUET_LOCAL_STT_URL) when Groq refuses or fails.
// Without the setting nothing changes: a Groq failure is an error, as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

async function stub() {
  const calls = []
  const srv = http.createServer((req, res) => {
    calls.push(req.url)
    req.resume().on('end', () => {
      if (req.url === '/groq') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Rate limit reached"}}') }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: ' Hey Duet, what time is it? [BLANK_AUDIO]\n' }))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  return { at: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() }
}

async function load(env) {
  Object.assign(process.env, { DUET_CONFIG: '/nonexistent', DUET_MESSAGES: 'off', GROQ_API_KEY: 'test', ANTHROPIC_API_KEY: '', ...env })
  return import(`./duet-server.mjs?${new URLSearchParams(env)}`)
}

test('without DUET_LOCAL_STT_URL, Groq refusing is an error (unchanged)', async () => {
  const s = await stub()
  try {
    const { transcribe } = await load({ DUET_GROQ_URL: `${s.at}/groq`, DUET_LOCAL_STT_URL: '' })
    await assert.rejects(transcribe(Buffer.alloc(16000), 'wake'), /said 429/)
    assert.deepEqual(s.calls, ['/groq'])
  } finally { s.close() }
})

test('with DUET_LOCAL_STT_URL, Groq refusing (429) falls back to the local whisper-server', async () => {
  const s = await stub()
  try {
    const { transcribe } = await load({ DUET_GROQ_URL: `${s.at}/groq`, DUET_LOCAL_STT_URL: `${s.at}/inference` })
    assert.equal(await transcribe(Buffer.alloc(16000), 'wake'), 'Hey Duet, what time is it?')
    assert.deepEqual(s.calls, ['/groq', '/inference'])
  } finally { s.close() }
})
