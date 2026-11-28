// Duet's text-message tools: read recent texts, read a thread, and send a text (after a yes on the lens).
// The messages live in macOS Messages on the server's Mac; messages-helper.mjs reads and sends them. The server
// reaches the helper over ssh to localhost (macOS blocks a launchd process from ~/Library/Messages), with a key
// that can run only the helper. Set DUET_MESSAGES=ssh (default when the key exists), or off.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MESSAGE_READ_TOOLS = new Set(['messages_recent', 'messages_thread'])
export const MESSAGE_WRITE_TOOLS = new Set(['messages_send'])

export const MESSAGE_TOOLS = [
  {
    name: 'messages_recent',
    description: 'The wearer\'s recent incoming text messages (iMessage/SMS), newest first: sender name, text, time, unread. Use for "any texts?", "what did Mom say?".',
    input_schema: { type: 'object', properties: {
      hours: { type: 'integer', minimum: 1, maximum: 336, description: 'How far back (default 24)' },
      max: { type: 'integer', minimum: 1, maximum: 40, description: 'Most messages to return (default 15)' },
    }, additionalProperties: false },
  },
  {
    name: 'messages_thread',
    description: 'The last messages, both ways, with one person. Give a contact name or a phone number / email.',
    input_schema: { type: 'object', properties: { contact: { type: 'string' } }, required: ['contact'], additionalProperties: false },
  },
  {
    name: 'messages_send',
    description: 'Text someone (iMessage, or SMS through the phone). `to` is a contact name, phone number or email. Write the text as the wearer would: short, casual, no sign-off. The wearer sees the draft on the glasses and confirms before it is sent.',
    input_schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'], additionalProperties: false },
  },
]

export const MESSAGE_STATUS = { messages_recent: 'checking your texts', messages_thread: 'reading the texts', messages_send: 'drafting the text' }

export const MESSAGES_SYSTEM = `

You can also read and send the wearer's text messages (messages_recent, messages_thread, messages_send).
- "Any texts?" means unread or recent incoming texts: give the sender's first name and the gist, one line each.
- To reply to someone, call messages_send with their name; the glasses show the draft and ask "yes or no" themselves.`

const HANDLE = /^(\+?[0-9]{5,15}|[^\s@'"]{1,64}@[^\s@'"]{1,255})$/
const phoneish = s => /^[+()0-9 .-]{5,20}$/.test(s.trim())
const cleanHandle = s => (phoneish(s) ? s.replace(/[^+0-9]/g, '') : s.trim())

/** Runs the helper: over ssh to localhost with the restricted key, or directly (tests, or a Mac where node has Full Disk Access). */
export function helperRunner({ key = path.join(os.homedir(), '.ssh', 'duet_messages'), direct = '' } = {}) {
  return (args, input = '') => new Promise((resolve, reject) => {
    const [cmd, argv] = direct
      ? [process.execPath, [direct, ...args]]
      : ['/usr/bin/ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=5', 'localhost', ...args]]
    const child = execFile(cmd, argv, { timeout: 25_000, maxBuffer: 4 << 20 }, (error, stdout) => {
      let out
      try { out = JSON.parse(String(stdout).trim().split('\n').pop() || '{}') } catch { return reject(new Error(error ? `messages helper failed: ${error.message.split('\n')[0]}` : 'messages helper sent bad output')) }
      if (out && !Array.isArray(out) && out.error) return reject(new Error(out.error))
      resolve(out)
    })
    child.stdin.end(input)
  })
}

export function loadMessages() {
  const mode = process.env.DUET_MESSAGES || ''
  if (mode === 'off') return null
  const key = path.join(os.homedir(), '.ssh', 'duet_messages')
  if (mode === 'direct') return new Messages(helperRunner({ direct: path.join(path.dirname(new URL(import.meta.url).pathname), 'messages-helper.mjs') }))
  if (mode === 'ssh' || existsSync(key)) return new Messages(helperRunner({ key }))
  return null
}

export class Messages {
  constructor(run) { this.run = run }
  recent({ hours = 24, max = 15 } = {}) { return this.run(['recent', String(hours), String(max)]) }
  who(name) { return this.run(['who', ...name.trim().split(/\s+/).slice(0, 4)]) }
  send(handle, body) { return this.run(['send', handle], body) }

  /** A contact name, number or email -> { name, handle }. Throws with the choices when a name matches several people. */
  async resolve(contact) {
    const c = String(contact).trim()
    if (HANDLE.test(cleanHandle(c))) return { name: c, handle: cleanHandle(c) }
    if (!/^[\p{L}\p{M} .'-]{2,40}$/u.test(c)) throw new Error('give a contact name, phone number or email')
    const found = await this.who(c)
    if (!found.length) throw new Error(`no contact named "${c}"`)
    const exact = found.filter(f => f.name.toLowerCase() === c.toLowerCase())
    const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null
    if (!pick) throw new Error(`several contacts match "${c}": ${found.map(f => f.name).join(', ')}. Ask the wearer which one.`)
    // The helper lists the number or email last texted with first.
    const handle = pick.handles[0]
    return { name: pick.name, handle: handle.includes('@') ? handle : `+${handle.length === 10 ? '1' + handle : handle}` }
  }

  async thread({ contact }) {
    const who = await this.resolve(contact)
    return { with: who.name, messages: await this.run(['thread', who.handle, '12']) }
  }
}

export function invalidMessageInput(name, input) {
  if (!input || typeof input !== 'object') return 'input must be an object'
  if (name === 'messages_thread' && (typeof input.contact !== 'string' || !input.contact.trim())) return 'missing contact'
  if (name === 'messages_send') {
    if (typeof input.to !== 'string' || !input.to.trim()) return 'missing to'
    if (typeof input.body !== 'string' || !input.body.trim()) return 'missing body'
    if (input.body.length > 1000) return 'body is too long for a text'
  }
  return ''
}

export async function runMessageRead(messages, name, input) {
  if (name === 'messages_recent') return messages.recent(input)
  if (name === 'messages_thread') return messages.thread(input)
  throw new Error(`not a messages read tool: ${name}`)
}

export async function prepareMessageWrite(messages, name, input) {
  if (name !== 'messages_send') throw new Error(`not a messages write tool: ${name}`)
  const who = await messages.resolve(input.to)
  const shown = who.name === who.handle ? who.handle : who.name
  return { verb: 'Send', prompt: `Text ${shown}\n"${input.body.trim()}"`, run: () => messages.send(who.handle, input.body.trim()) }
}

/** Fake Messages for DUET_FAKE runs and tests. */
export const fakeMessages = new Messages(async (args, input) => {
  if (args[0] === 'recent') return [{ from: 'Sam Lee', handle: '+15035550100', text: 'Running 10 min late, save me a seat', time: '2026-11-27T20:01:00Z', unread: true }]
  if (args[0] === 'who') return args.slice(1).join(' ').toLowerCase().startsWith('sam') ? [{ name: 'Sam Lee', handles: ['5035550100'] }] : []
  if (args[0] === 'thread') return [{ from: 'Sam Lee', text: 'Running 10 min late', time: '2026-11-27T20:01:00Z', unread: true }]
  if (args[0] === 'send') return { sent: true, via: 'iMessage', text: input }
  throw new Error('unknown')
})
