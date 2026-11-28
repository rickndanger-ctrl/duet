// Duet Muse: reading Muse's window, and whole turns against a stand-in relay that behaves like the real one
// (it calls the job done while Muse still shows "Musa / is working").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readMuse, sameQuestion } from './muse-reply.mjs'

const HISTORY = ['Approvals history', 'Share a one-time code in Browser', 'The agent will see your one-time code.', 'Allowed once · 10h ago',
  'Share a one-time code in Browser', 'The agent will see your one-time code.', 'Timed out · 10h ago']
const window = (...lines) => [...lines, ...HISTORY].join('\n')

test('the stub while Muse thinks is not an answer', () => {
  const seen = readMuse(window('Musa', 'is working'))
  assert.equal(seen.answer, '')
  assert.equal(seen.state, 'is working')
  assert.equal(seen.working, true)
  assert.equal(seen.idle, false)
  assert.equal(seen.approval, '')
})

test('a finished answer: the text above the card, without the card or the approval history', () => {
  const seen = readMuse(window('Four tablespoons.', 'Want the metric too?', 'Musa', 'Connected'))
  assert.equal(seen.answer, 'Four tablespoons.\nWant the metric too?')
  assert.equal(seen.idle, true)
  assert.equal(seen.approval, '')
})

test('text written while Muse is still working is not final', () => {
  const seen = readMuse(window('Looking into it, first', 'Musa', 'is working'))
  assert.equal(seen.answer, 'Looking into it, first')
  assert.equal(seen.idle, false)
})

test('an approval waiting in the window: the newest history row has no outcome', () => {
  const lines = ['Musa', 'is working', 'Approvals history', 'Allow access to calendar.google.com', 'The agent wants to open your calendar.', ...HISTORY.slice(1)]
  const seen = readMuse(lines.join('\n'))
  assert.equal(seen.approval, 'Allow access to calendar.google.com')
  assert.equal(seen.idle, false)
})

test('an approval named by the state line', () => {
  assert.equal(readMuse(window('Musa', 'is waiting for approval')).approval, 'is waiting for approval')
})

test('"Connected" wins over an odd history row (an unknown outcome word never holds the answer back)', () => {
  const lines = ['Done.', 'Musa', 'Connected', 'Approvals history', 'Allow access to example.com', 'Something new']
  const seen = readMuse(lines.join('\n'))
  assert.equal(seen.idle, true)
  assert.equal(seen.answer, 'Done.')
})

test('a line "Musa" inside the answer is not the card', () => {
  const seen = readMuse(window('Musa', 'is the name I go by here, and I can help with that.', 'Musa', 'Connected'))
  assert.equal(seen.answer, 'Musa\nis the name I go by here, and I can help with that.')
  assert.equal(seen.idle, true)
})

test('no card (a Muse update moved it): the answer is still cleaned of the history', () => {
  const seen = readMuse(['Paris.', ...HISTORY].join('\n'))
  assert.equal(seen.card, false)
  assert.equal(seen.answer, 'Paris.')
})

test('questions match loosely (curly quotes, spaces, the note added at the end)', () => {
  assert.ok(sameQuestion('What’s  next? (Answer for my glasses: short, plain text.)', "what's next? (answer for my glasses: short, plain text.)"))
  assert.ok(!sameQuestion('What is next?', 'Something else'))
  // A follow-up that starts with the earlier question is a different question (its answer must not be taken for ours).
  assert.ok(!sameQuestion('Give me my pie recipe? (Answer for my glasses: short, plain text.)', 'Give me my pie recipe? And the pecan one. (Answer for my glasses: short, plain text.)'))
  assert.ok(!sameQuestion('Give me my pie recipe?', 'Give me my pie recipe? And the pecan one.'))
  assert.ok(!sameQuestion('', ''))
})

// ---- whole turns ---------------------------------------------------------------------------------------------------

/** A stand-in relay. `script(job, reads)` returns Muse's window lines after the question on each read. */
function fakeRelay({ script, relayDoneAfter = 3, selftest = { ok: true, museRunning: true, accessibility: true, composer: true, busy: false }, failSend = '' }) {
  const jobs = new Map()
  let latestReads = 0
  const asked = []
  const srv = http.createServer(async (req, res) => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/selftest') return send(200, selftest)
    if (req.headers.authorization !== 'Bearer relay-token') return send(401, { error: 'unauthorized' })
    if (req.method === 'POST' && url.pathname === '/ask') {
      let body = ''; for await (const c of req) body += c
      const job = { id: String(jobs.size + 1), question: JSON.parse(body).text, reads: 0 }
      jobs.set(job.id, job); asked.push(job.question)
      return send(200, { id: job.id, status: 'queued' })
    }
    if (url.pathname.startsWith('/reply/')) {
      const job = jobs.get(url.pathname.slice(7))
      if (failSend) return send(200, { id: job.id, status: 'error', question: job.question, reply: '', error: failSend })
      job.reads++
      // Like the real relay: it stops reading after a while and keeps what it last saw (the stub).
      const status = job.reads === 1 ? 'sending' : job.reads > relayDoneAfter ? 'done' : 'waiting'
      return send(200, { id: job.id, status, question: job.question, reply: script(job, Math.min(job.reads, relayDoneAfter)).join('\n') })
    }
    if (url.pathname === '/latest') {
      const job = [...jobs.values()].at(-1)
      latestReads++
      return send(200, { question: job.question, reply: script(job, job.reads + latestReads).join('\n') })
    }
    send(404, {})
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, asked, close: () => srv.close() })))
}

let museServer
async function startMuseServer(relayUrl) {
  process.env.DUET_MUSE_URL = relayUrl
  process.env.DUET_MUSE_TOKEN = 'relay-token'
  process.env.DUET_MUSE_NAME_LABEL = 'My Mac'
  process.env.DUET_TOKEN = 'app-token'
  process.env.DUET_MUSE_POLL_MS = '20'
  process.env.DUET_MUSE_LATEST_MS = '20'
  process.env.DUET_CONFIG = '/nonexistent'
  const { server } = await import(`./muse-server.mjs?relay=${encodeURIComponent(relayUrl)}`)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  museServer = server
  return `http://127.0.0.1:${server.address().port}`
}

async function turn(base, text) {
  const auth = { Authorization: 'Bearer app-token' }
  const r = await fetch(`${base}/v1/chat`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: 'test-conversation', text }) })
  assert.equal(r.status, 200)
  const { turn } = await r.json()
  const events = []
  for (let after = 0; ;) {
    const page = await (await fetch(`${base}/v1/turn/${turn}?after=${after}`, { headers: auth })).json()
    events.push(...page.events); after = page.next
    if (page.done) return events
  }
}

test('a turn waits past the "is working" stub for the real answer (the relay alone returned the stub)', async () => {
  const relay = await fakeRelay({
    relayDoneAfter: 3,
    // Muse thinks through the relay's whole watch and a few reads after it, then answers.
    script: (job, n) => n < 7 ? ['Musa', 'is working', ...HISTORY] : ['A quarter cup is 4 tablespoons.', 'Musa', 'Connected', ...HISTORY],
  })
  const base = await startMuseServer(relay.url)
  try {
    const events = await turn(base, 'How many tablespoons in a quarter cup?')
    const text = events.filter(e => e.t === 'delta').map(e => e.text).join('')
    assert.equal(text, 'A quarter cup is 4 tablespoons.')
    assert.ok(events.some(e => e.t === 'status' && e.text === 'Muse is working'))
    assert.equal(events.at(-1).t, 'done')
    assert.match(relay.asked[0], /^How many tablespoons in a quarter cup\? \(Answer for my glasses/)
  } finally {
    museServer.close(); relay.close()
  }
})

test('an approval waiting in Muse shows on the lens, then the answer follows', async () => {
  const relay = await fakeRelay({
    script: (job, n) => n < 4 ? ['Musa', 'is working', 'Approvals history', 'Allow access to calendar.google.com', 'The agent wants your calendar.', ...HISTORY.slice(1)]
      : ['You have two meetings tomorrow.', 'Musa', 'Connected', 'Approvals history', 'Allow access to calendar.google.com', 'The agent wants your calendar.', 'Allowed once · just now', ...HISTORY.slice(1)],
  })
  const base = await startMuseServer(relay.url)
  try {
    const events = await turn(base, 'What is on my calendar tomorrow?')
    assert.ok(events.some(e => e.t === 'status' && e.text === 'approve it on My Mac'))
    assert.equal(events.filter(e => e.t === 'delta').map(e => e.text).join(''), 'You have two meetings tomorrow.')
  } finally {
    museServer.close(); relay.close()
  }
})

test('Muse not ready: the lens says so instead of waiting', async () => {
  const relay = await fakeRelay({ script: () => [], selftest: { ok: true, museRunning: true, accessibility: true, composer: false, busy: false } })
  const base = await startMuseServer(relay.url)
  try {
    const events = await turn(base, 'Hello there')
    assert.deepEqual(events.at(-1), { t: 'error', message: 'Muse box not ready' })
    assert.equal(relay.asked.length, 0)
  } finally {
    museServer.close(); relay.close()
  }
})

test("Muse's text box didn't take focus: asked once more (nothing was typed), then a short error", async () => {
  const relay = await fakeRelay({ script: () => [], failSend: 'Command failed: musectl send x\ncomposer did not take focus; nothing typed' })
  const base = await startMuseServer(relay.url)
  try {
    const events = await turn(base, 'Hello there')
    assert.equal(relay.asked.length, 2)
    assert.deepEqual(events.at(-1), { t: 'error', message: "Muse didn't type it" })
  } finally {
    museServer.close(); relay.close()
  }
})

test('the app token is required', async () => {
  const relay = await fakeRelay({ script: () => [] })
  const base = await startMuseServer(relay.url)
  try {
    assert.equal((await fetch(`${base}/v1/chat`, { method: 'POST', body: '{}' })).status, 401)
    assert.equal((await (await fetch(`${base}/health`)).json()).muse, true)
  } finally {
    museServer.close(); relay.close()
  }
})

test('speech to text: wake checks run locally (no Groq quota); Groq refusing (429) falls back to local', async () => {
  const calls = []
  const stub = http.createServer((req, res) => {
    calls.push(req.url)
    req.resume().on('end', () => {
      if (req.url === '/groq') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Rate limit reached"}}') }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: ' ♪ Hey Muse, what time is it? [BLANK_AUDIO]\n' }))
    })
  })
  await new Promise(r => stub.listen(0, '127.0.0.1', r))
  const at = `http://127.0.0.1:${stub.address().port}`
  process.env.DUET_GROQ_URL = `${at}/groq`
  process.env.DUET_LOCAL_STT_URL = `${at}/inference`
  process.env.GROQ_API_KEY = 'test-key'
  const relay = await fakeRelay({ script: () => [] })
  const base = await startMuseServer(relay.url)
  const stt = async mode => (await (await fetch(`${base}/v1/stt?mode=${mode}`, { method: 'POST', headers: { Authorization: 'Bearer app-token' }, body: Buffer.alloc(16000) })).json()).text
  try {
    assert.equal(await stt('wake'), 'Hey Muse, what time is it?')
    assert.deepEqual(calls, ['/inference'])
    assert.equal(await stt('talk'), 'Hey Muse, what time is it?')
    assert.deepEqual(calls, ['/inference', '/groq', '/inference'])
  } finally {
    delete process.env.DUET_GROQ_URL; delete process.env.DUET_LOCAL_STT_URL; delete process.env.GROQ_API_KEY
    museServer.close(); relay.close(); stub.close()
  }
})

test('words added right after a question go to Muse as a follow-up, and the lens shows both answers', async () => {
  const answers = { pie: 'Chocolate custard: eggs, sugar, cocoa, milk.', pecan: 'Pecan: corn syrup, pecans, eggs.' }
  const relay = await fakeRelay({
    script: (job, n) => n < 2 ? [] : [/pecan/i.test(job.question) ? answers.pecan : answers.pie, 'Musa', 'Connected', ...HISTORY],
  })
  const base = await startMuseServer(relay.url)
  const auth = { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' }
  const chat = async text => (await (await fetch(`${base}/v1/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ conversation: 'join-conversation', text }) })).json()).turn
  try {
    // The wearer pauses after the first part; Duet asks, then joins the rest and asks again (cancelling the first turn).
    const first = await chat('Give me my pie recipe?')
    await new Promise(r => setTimeout(r, 60))
    await fetch(`${base}/v1/turn/${first}/cancel`, { method: 'POST', headers: auth })
    const second = await chat('Give me my pie recipe? And the pecan one.')
    const events = []
    for (let after = 0; ;) {
      const page = await (await fetch(`${base}/v1/turn/${second}?after=${after}`, { headers: auth })).json()
      events.push(...page.events); after = page.next
      if (page.done) break
    }
    assert.equal(relay.asked.length, 2)
    assert.match(relay.asked[0], /^Give me my pie recipe\? \(Answer/)
    assert.match(relay.asked[1], /^And the pecan one\. \(Answer/)
    assert.equal(events.filter(e => e.t === 'delta').map(e => e.text).join(''), `${answers.pie}\n\n${answers.pecan}`)
  } finally {
    museServer.close(); relay.close()
  }
})

test('addedTo: only a true extension counts', async () => {
  const { addedTo } = await import('./muse-server.mjs')
  assert.equal(addedTo('Give me my pie recipe?', 'Give me my pie recipe? And the pecan one.'), 'And the pecan one.')
  assert.equal(addedTo('Give me my pie recipe?', 'Something else entirely'), '')
  assert.equal(addedTo('Same', 'Same'), '')
})
