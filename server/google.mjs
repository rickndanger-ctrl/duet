// Google Calendar + Gmail for Duet, over plain REST (no client library).
// Credentials: DUET_CONFIG/google.json = { client_id, client_secret, refresh_token } (made by google-auth.mjs).
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

export function loadGoogle(configDir) {
  try {
    const creds = JSON.parse(readFileSync(path.join(configDir, 'google.json'), 'utf8'))
    return creds.refresh_token && creds.client_id ? new Google(creds) : null
  } catch { return null }
}

const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
/** Header values may not contain line breaks (header injection). */
const oneLine = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()

export class Google {
  constructor(creds) { this.creds = creds; this.token = ''; this.expires = 0 }

  async accessToken() {
    if (this.token && Date.now() < this.expires - 60_000) return this.token
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.creds.client_id, client_secret: this.creds.client_secret, refresh_token: this.creds.refresh_token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Google sign-in failed (${res.status}); run google-auth.mjs again`)
    const j = await res.json()
    this.token = j.access_token
    this.expires = Date.now() + (j.expires_in || 3600) * 1000
    return this.token
  }

  async api(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Google API ${res.status}: ${detail.slice(0, 200)}`)
    }
    return res.status === 204 ? {} : res.json()
  }

  // ---- Calendar ------------------------------------------------------------

  async listEvents({ from, to, query }) {
    const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '15' })
    if (query) q.set('q', query)
    const j = await this.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`)
    return (j.items || []).map(e => ({
      event_id: e.id,
      title: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || undefined,
      attendees: (e.attendees || []).filter(a => !a.self).slice(0, 8).map(a => a.displayName || a.email),
      meet_link: e.hangoutLink || undefined,
      description: e.description ? e.description.slice(0, 300) : undefined,
    }))
  }

  async getEvent(id) {
    return this.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`)
  }

  async createEvent({ title, start, end, location, attendees, timezone }) {
    const body = {
      summary: title,
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
      ...(location ? { location } : {}),
      ...(attendees?.length ? { attendees: attendees.map(email => ({ email })) } : {}),
    }
    const e = await this.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${attendees?.length ? 'all' : 'none'}`, { method: 'POST', body: JSON.stringify(body) })
    return { event_id: e.id, title: e.summary, start: e.start?.dateTime, end: e.end?.dateTime }
  }

  async updateEvent({ event_id, start, end, title, timezone }) {
    const body = {}
    if (title) body.summary = title
    if (start) body.start = { dateTime: start, timeZone: timezone }
    if (end) body.end = { dateTime: end, timeZone: timezone }
    const e = await this.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event_id)}?sendUpdates=all`, { method: 'PATCH', body: JSON.stringify(body) })
    return { event_id: e.id, title: e.summary, start: e.start?.dateTime, end: e.end?.dateTime }
  }

  // ---- Gmail ---------------------------------------------------------------

  async searchMail({ query, max = 8 }) {
    const q = new URLSearchParams({ q: query || 'in:inbox', maxResults: String(Math.min(10, Math.max(1, max))) })
    const list = await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`)
    const ids = (list.messages || []).map(m => m.id)
    return Promise.all(ids.map(async id => {
      const m = await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
      const h = name => m.payload?.headers?.find(x => x.name.toLowerCase() === name)?.value || ''
      return { message_id: m.id, from: h('from'), subject: h('subject'), date: h('date'), snippet: decodeEntities(m.snippet || ''), unread: (m.labelIds || []).includes('UNREAD') }
    }))
  }

  async readMail({ message_id }) {
    const m = await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message_id)}?format=full`)
    const h = name => m.payload?.headers?.find(x => x.name.toLowerCase() === name)?.value || ''
    return { message_id: m.id, from: h('from'), to: h('to'), subject: h('subject'), date: h('date'), body: bodyText(m.payload).slice(0, 4000) }
  }

  /** The headers a reply needs, read from Gmail (never trusted from the model). */
  async replyTarget(message_id) {
    const m = await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message_id)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`)
    const h = name => m.payload?.headers?.find(x => x.name.toLowerCase() === name)?.value || ''
    const subject = h('subject')
    return {
      threadId: m.threadId,
      to: h('reply-to') || h('from'),
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      messageId: h('message-id'),
      references: [h('references'), h('message-id')].filter(Boolean).join(' '),
    }
  }

  async send({ to, subject, body, threadId, inReplyTo, references }) {
    const lines = [
      `To: ${oneLine(to)}`,
      `Subject: ${oneLine(subject)}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      ...(inReplyTo ? [`In-Reply-To: ${oneLine(inReplyTo)}`, `References: ${oneLine(references || inReplyTo)}`] : []),
      '',
      String(body),
    ]
    const j = await this.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', body: JSON.stringify({ raw: b64url(lines.join('\r\n')), ...(threadId ? { threadId } : {}) }),
    })
    return { sent: true, message_id: j.id }
  }
}

function decodeEntities(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** The plain-text body of a message (HTML stripped if that's all there is). Quoted history is cut. */
function bodyText(payload) {
  const parts = []
  const walk = p => {
    if (!p) return
    if (p.parts) p.parts.forEach(walk)
    else if (p.body?.data) parts.push({ type: p.mimeType, text: fromB64url(p.body.data) })
  }
  walk(payload)
  let text = parts.find(p => p.type === 'text/plain')?.text
  if (!text) {
    const html = parts.find(p => p.type === 'text/html')?.text || ''
    text = decodeEntities(html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' '))
  }
  // Drop quoted replies ("On ... wrote:" and "> " lines).
  const cut = text.search(/\n\s*On .{5,200}wrote:\s*\n/)
  if (cut > 0) text = text.slice(0, cut)
  return text.split('\n').filter(l => !l.startsWith('>')).join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
