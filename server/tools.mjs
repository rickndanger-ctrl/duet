// Duet's Google tools for Claude. Reads run at once; anything that sends or changes something
// first asks the wearer on the lens ("Send? yes / no") and runs only on a yes.

export const READ_TOOLS = new Set(['calendar_events', 'gmail_search', 'gmail_read'])
export const WRITE_TOOLS = new Set(['calendar_create_event', 'calendar_update_event', 'gmail_reply', 'gmail_send'])

const iso = 'ISO 8601 with the wearer\'s UTC offset, e.g. 2026-11-28T15:00:00-05:00'

export const GOOGLE_TOOLS = [
  {
    name: 'calendar_events',
    description: 'List events on the wearer\'s Google Calendar between two times (max 15). Use for "what\'s next", "am I free at 3", meeting briefs. event_id is needed to move or change an event.',
    input_schema: { type: 'object', properties: {
      from: { type: 'string', description: `Start of the window, ${iso}` },
      to: { type: 'string', description: `End of the window, ${iso}` },
      query: { type: 'string', description: 'Optional text to match (title, attendee, place)' },
    }, required: ['from', 'to'], additionalProperties: false },
  },
  {
    name: 'calendar_create_event',
    description: 'Add an event to the wearer\'s calendar. The wearer is asked to confirm on the glasses before it is created. Invites are emailed only if attendees are given.',
    input_schema: { type: 'object', properties: {
      title: { type: 'string' },
      start: { type: 'string', description: iso },
      end: { type: 'string', description: `${iso}. Default to one hour after start if the wearer gave no length.` },
      location: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite (only if the wearer asked to invite someone)' },
    }, required: ['title', 'start', 'end'], additionalProperties: false },
  },
  {
    name: 'calendar_update_event',
    description: 'Move or rename an existing event (get event_id from calendar_events first). Keep the same length when moving unless told otherwise. The wearer confirms on the glasses first; attendees are notified.',
    input_schema: { type: 'object', properties: {
      event_id: { type: 'string' },
      start: { type: 'string', description: `New start, ${iso}` },
      end: { type: 'string', description: `New end, ${iso}` },
      title: { type: 'string', description: 'New title, only if renaming' },
    }, required: ['event_id'], additionalProperties: false },
  },
  {
    name: 'gmail_search',
    description: 'Search the wearer\'s Gmail with Gmail search syntax (e.g. "is:unread in:inbox", "from:sam newer_than:7d"). Returns sender, subject, date, snippet and message_id for up to 10 messages.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string' },
      max: { type: 'integer', minimum: 1, maximum: 10 },
    }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'gmail_read',
    description: 'Read one email\'s full text by message_id (from gmail_search).',
    input_schema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false },
  },
  {
    name: 'gmail_reply',
    description: 'Reply to an email (message_id from gmail_search) in the same thread. Write the reply as the wearer would: short, natural, signed with nothing. The wearer sees the draft on the glasses and confirms before it is sent.',
    input_schema: { type: 'object', properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'], additionalProperties: false },
  },
  {
    name: 'gmail_send',
    description: 'Send a new email. Only use an address the wearer said or that you found in their mail (search first). The wearer confirms the draft on the glasses before it is sent.',
    input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'], additionalProperties: false },
  },
]

/** Checks a tool input against its schema's required string fields (the model's input is untrusted). Returns an error or ''. */
export function invalidInput(name, input) {
  const tool = GOOGLE_TOOLS.find(t => t.name === name)
  if (!tool) return `unknown tool ${name}`
  if (!input || typeof input !== 'object') return 'input must be an object'
  for (const key of tool.input_schema.required) {
    if (typeof input[key] !== 'string' || !input[key].trim()) return `missing ${key}`
  }
  for (const key of ['from', 'to', 'start', 'end']) {
    if (key === 'to' && name === 'gmail_send') continue
    if (input[key] !== undefined && Number.isNaN(Date.parse(input[key]))) return `${key} is not a date`
  }
  if (name === 'gmail_send' && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.to.trim())) return 'to must be one plain email address'
  return ''
}

const when = (s, tz) => {
  try {
    return new Date(s).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || undefined })
  } catch { return s }
}
const nameOf = addr => String(addr).replace(/\s*<[^>]*>\s*$/, '').replace(/"/g, '').trim() || addr

/**
 * Prepares a write: fetches what the lens needs to show and returns { prompt, verb, run }.
 * `run` performs the action and returns the tool result.
 */
export async function prepareWrite(google, name, input, ctx) {
  const tz = ctx?.tz
  if (name === 'gmail_reply') {
    const target = await google.replyTarget(input.message_id)
    return {
      verb: 'Send',
      prompt: `Reply to ${nameOf(target.to)}\n${target.subject}\n"${input.body.trim()}"`,
      run: () => google.send({ to: target.to, subject: target.subject, body: input.body, threadId: target.threadId, inReplyTo: target.messageId, references: target.references }),
    }
  }
  if (name === 'gmail_send') {
    return {
      verb: 'Send',
      prompt: `Email ${input.to}\n${input.subject}\n"${input.body.trim()}"`,
      run: () => google.send({ to: input.to, subject: input.subject, body: input.body }),
    }
  }
  if (name === 'calendar_create_event') {
    const who = input.attendees?.length ? `\nInvite: ${input.attendees.join(', ')}` : ''
    return {
      verb: 'Add',
      prompt: `New event: ${input.title}\n${when(input.start, tz)} - ${when(input.end, tz).split(', ').pop()}${input.location ? `\nAt ${input.location}` : ''}${who}`,
      run: () => google.createEvent({ ...input, timezone: tz }),
    }
  }
  if (name === 'calendar_update_event') {
    const e = await google.getEvent(input.event_id)
    const was = e.start?.dateTime || e.start?.date
    const parts = [`Change: ${e.summary || '(no title)'}`]
    if (input.start) parts.push(`${when(was, tz)} → ${when(input.start, tz)}`)
    if (input.title) parts.push(`New title: ${input.title}`)
    if ((e.attendees || []).some(a => !a.self)) parts.push('Attendees will be notified.')
    return { verb: 'Move', prompt: parts.join('\n'), run: () => google.updateEvent({ ...input, timezone: tz }) }
  }
  throw new Error(`not a write tool: ${name}`)
}

export async function runRead(google, name, input) {
  if (name === 'calendar_events') return google.listEvents(input)
  if (name === 'gmail_search') return google.searchMail(input)
  if (name === 'gmail_read') return google.readMail(input)
  throw new Error(`not a read tool: ${name}`)
}

/** Fake Google for DUET_FAKE runs and tests. */
export const fakeGoogle = {
  async listEvents() { return [{ event_id: 'ev1', title: 'Pie tasting with Sam', start: '2026-11-28T15:00:00-05:00', end: '2026-11-28T16:00:00-05:00', attendees: ['Sam Lee'] }] },
  async getEvent() { return { summary: 'Pie tasting with Sam', start: { dateTime: '2026-11-28T15:00:00-05:00' }, attendees: [{ email: 'sam@example.com' }] } },
  async updateEvent(i) { return { event_id: i.event_id, start: i.start } },
  async createEvent(i) { return { event_id: 'ev2', title: i.title } },
  async searchMail() { return [{ message_id: 'm1', from: 'Sam Lee <sam@example.com>', subject: 'Lunch Friday?', date: 'Thu, 27 Nov 2026', snippet: 'Are we still on for lunch?', unread: true }] },
  async readMail() { return { message_id: 'm1', from: 'Sam Lee <sam@example.com>', subject: 'Lunch Friday?', body: 'Are we still on for lunch Friday at noon?' } },
  async replyTarget() { return { to: 'Sam Lee <sam@example.com>', subject: 'Re: Lunch Friday?', threadId: 't1', messageId: '<m1@x>', references: '<m1@x>' } },
  async send() { return { sent: true, message_id: 'm2' } },
}
