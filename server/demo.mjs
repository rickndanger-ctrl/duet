// DUET_DEMO=1: real Claude and real speech-to-text, but the calendar, inbox and texts are a made-up demo account
// (Sam Lee, Maya Chen...). Sends and moves change only this in-memory demo data. For demo videos and for trying Duet
// without connecting Google or Messages. Times are relative to when the server starts, in DUET_DEMO_TZ.
import { Messages } from './messages.mjs'

const TZ = process.env.DUET_DEMO_TZ || 'America/Los_Angeles'

/** Minutes TZ is ahead of UTC at `d`. */
const offMin = d => (Date.parse(d.toLocaleString('en-US', { timeZone: TZ })) - Date.parse(d.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60_000
/** Local wall-clock time `h:m` on the day `dayOffset` days from today, in TZ. */
function at(dayOffset, h, m = 0) {
  const now = new Date()
  const [y, mo, dd] = now.toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, dd + dayOffset, h, m) - offMin(now) * 60_000)
}
/** The next half hour that is at least 25 minutes away. */
const soon = () => new Date(Math.ceil((Date.now() + 25 * 60_000) / 1_800_000) * 1_800_000)
const iso = d => {
  const off = offMin(d), w = new Date(d.getTime() + off * 60_000), a = Math.abs(off)
  const p = n => String(n).padStart(2, '0')
  return `${w.getUTCFullYear()}-${p(w.getUTCMonth() + 1)}-${p(w.getUTCDate())}T${p(w.getUTCHours())}:${p(w.getUTCMinutes())}:00${off < 0 ? '-' : '+'}${p(a / 60 | 0)}:${p(a % 60)}`
}
const hour = 3600_000

export function demoAccount() {
  const s = soon()
  const events = [
    { event_id: 'd1', title: 'Design review: Duet launch', start: iso(s), end: iso(new Date(+s + hour)), location: 'Room 4B', attendees: ['Sam Lee', 'Priya Nair'], description: 'Walk through the new onboarding mockups before Monday.' },
    { event_id: 'd2', title: 'Pie tasting with Maya', start: iso(at(1, 15)), end: iso(at(1, 16)), location: 'Pie Bird Bakery', attendees: ['Maya Chen'] },
    { event_id: 'd3', title: 'Weekly planning', start: iso(at(3, 9, 30)), end: iso(at(3, 10)), attendees: ['Sam Lee', 'Priya Nair', 'Jordan Park'] },
  ]
  const mail = [
    { message_id: 'm1', from: 'Sam Lee <sam@demo.example>', subject: 'Mockups for the design review', date: iso(new Date(Date.now() - 50 * 60_000)), unread: true,
      body: 'Hi! I put the new onboarding mockups in the shared folder. Can you look at screens 3 and 4 before we meet? I think the second step is too long. - Sam' },
    { message_id: 'm2', from: 'Priya Nair <priya@demo.example>', subject: 'Launch checklist', date: iso(new Date(Date.now() - 3 * hour)), unread: true,
      body: 'Checklist is 80% done. Still open: store screenshots and the privacy page. Can you own the privacy page?' },
    { message_id: 'm3', from: 'Maya Chen <maya@demo.example>', subject: 'Saturday', date: iso(new Date(Date.now() - 5 * hour)), unread: false,
      body: 'Still on for the pie tasting tomorrow at 3? I can bring the apple-cranberry one.' },
    { message_id: 'm4', from: 'Cascade Outfitters <deals@demo.example>', subject: 'Weekend sale: 30% off rain jackets', date: iso(new Date(Date.now() - 7 * hour)), unread: true,
      body: 'Our biggest sale of the season.' },
  ]
  const texts = [
    { from: 'Maya Chen', handle: '+15035550142', text: 'Can you grab oat milk on the way home?', time: new Date(Date.now() - 12 * 60_000).toISOString(), unread: true },
    { from: 'Sam Lee', handle: '+15035550117', text: 'Review moved to room 4B btw', time: new Date(Date.now() - 40 * 60_000).toISOString(), unread: true },
    { from: 'Jordan Park', handle: '+15035550188', text: 'Thanks for the notes yesterday!', time: new Date(Date.now() - 20 * hour).toISOString(), unread: false },
  ]
  const people = [
    { name: 'Maya Chen', handles: ['5035550142', 'maya@demo.example'] },
    { name: 'Sam Lee', handles: ['5035550117', 'sam@demo.example'] },
    { name: 'Priya Nair', handles: ['5035550163', 'priya@demo.example'] },
    { name: 'Jordan Park', handles: ['5035550188'] },
  ]
  const sent = []
  const nameOf = a => String(a).replace(/\s*<[^>]*>\s*$/, '')

  const google = {
    async listEvents({ from, to, query }) {
      const a = Date.parse(from), b = Date.parse(to), qq = (query || '').toLowerCase()
      return events.filter(e => Date.parse(e.end) > a && Date.parse(e.start) < b && (!qq || JSON.stringify(e).toLowerCase().includes(qq)))
        .sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
    },
    async getEvent(id) {
      const e = events.find(x => x.event_id === id)
      if (!e) throw new Error('no such event')
      return { summary: e.title, start: { dateTime: e.start }, end: { dateTime: e.end }, attendees: e.attendees.map(n => ({ email: n })) }
    },
    async updateEvent({ event_id, start, end, title }) {
      const e = events.find(x => x.event_id === event_id)
      if (!e) throw new Error('no such event')
      const len = Date.parse(e.end) - Date.parse(e.start)
      if (start) { e.start = start; e.end = end || iso(new Date(Date.parse(start) + len)) }
      if (title) e.title = title
      return { event_id, start: e.start, end: e.end, title: e.title }
    },
    async createEvent(i) { const e = { event_id: `d${events.length + 1}`, title: i.title, start: i.start, end: i.end, location: i.location, attendees: i.attendees || [] }; events.push(e); return e },
    async searchMail({ query = '', max = 10 }) {
      const q = query.toLowerCase()
      const words = q.replace(/\b(is|in|from|newer_than|older_than|label):\S*/g, '').split(/\s+/).filter(Boolean)
      const from = /from:(\S+)/.exec(q)?.[1]
      return mail.filter(m => (!/is:unread/.test(q) || m.unread) && (!from || m.from.toLowerCase().includes(from)) && words.every(w => JSON.stringify(m).toLowerCase().includes(w)))
        .slice(0, max).map(({ body, ...m }) => ({ ...m, snippet: body.slice(0, 120) }))
    },
    async readMail({ message_id }) { const m = mail.find(x => x.message_id === message_id); if (!m) throw new Error('no such message'); m.unread = false; return m },
    async replyTarget(id) { const m = mail.find(x => x.message_id === id); if (!m) throw new Error('no such message'); return { to: m.from, subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`, threadId: id, messageId: `<${id}@demo>`, references: `<${id}@demo>` } },
    async send(m) { sent.push({ kind: 'email', to: nameOf(m.to), body: m.body }); return { sent: true, message_id: `s${sent.length}` } },
  }

  const messages = new Messages(async (args, input) => {
    const [cmd, ...rest] = args
    if (cmd === 'recent') return texts.slice(0, Number(rest[1]) || 15)
    if (cmd === 'who') { const q = rest.join(' ').toLowerCase(); return people.filter(p => p.name.toLowerCase().includes(q)) }
    if (cmd === 'thread') { const k = rest[0].replace(/\D/g, '').slice(-10); return texts.filter(t => t.handle.endsWith(k)).map(t => ({ ...t, unread: undefined })) }
    if (cmd === 'send') { sent.push({ kind: 'text', to: rest[0], body: input }); return { sent: true, via: 'iMessage' } }
    throw new Error('unknown command')
  })

  return { google, messages, sent, place: process.env.DUET_DEMO_PLACE || 'Portland, Oregon', tz: TZ }
}
