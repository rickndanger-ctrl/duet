#!/usr/bin/env node
// Duet's Messages helper. Runs on the Mac that has the wearer's Messages (iMessage, and SMS if the iPhone forwards it).
// macOS lets only some processes read ~/Library/Messages (Full Disk Access), and the Duet server started by launchd
// is not one of them, so the server runs this over ssh to localhost with a key that may run nothing but this script
// (see docs/MESSAGES_SETUP.md). Commands come from SSH_ORIGINAL_COMMAND (or argv); every argument is checked.
//
//   recent <hours> <max>     incoming messages of the last hours, newest first, with contact names
//   thread <handle> <max>    the last messages with one person, both ways
//   who <name>               contacts matching a name: their phone numbers and emails
//   send <handle>            sends stdin (the text) to a phone number or email with Messages
// Output: JSON on stdout. Errors: {"error": "..."} and exit 1.
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'

const HOME = os.homedir()
const CHAT_DB = `${HOME}/Library/Messages/chat.db`
const APPLE_EPOCH = 978307200

const fail = msg => { process.stdout.write(JSON.stringify({ error: msg }) + '\n'); process.exit(1) }
const q = s => `'${String(s).replace(/'/g, "''")}'`
function sql(db, query) {
  const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', db, query], { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 10_000 })
  return out.trim() ? JSON.parse(out) : []
}

const HANDLE = /^(\+?[0-9]{5,15}|[^\s@'"]{1,64}@[^\s@'"]{1,255})$/
const digits = s => String(s).replace(/\D/g, '')
/** Phone numbers compare on their last 10 digits; emails lowercased. */
const key = h => (h.includes('@') ? h.toLowerCase() : digits(h).slice(-10))

/** handle key -> contact name, from every Contacts database on this Mac. */
function contacts() {
  const dbs = []
  const base = `${HOME}/Library/Application Support/AddressBook`
  if (existsSync(`${base}/AddressBook-v22.abcddb`)) dbs.push(`${base}/AddressBook-v22.abcddb`)
  try { for (const d of readdirSync(`${base}/Sources`)) if (existsSync(`${base}/Sources/${d}/AddressBook-v22.abcddb`)) dbs.push(`${base}/Sources/${d}/AddressBook-v22.abcddb`) } catch {}
  const names = new Map()
  for (const db of dbs) {
    const name = "trim(coalesce(r.ZFIRSTNAME,'') || ' ' || coalesce(r.ZLASTNAME,''))"
    const org = "coalesce(r.ZORGANIZATION, r.ZNICKNAME, '')"
    try {
      for (const row of sql(db, `select ${name} n, ${org} o, p.ZFULLNUMBER h from ZABCDPHONENUMBER p join ZABCDRECORD r on r.Z_PK = p.ZOWNER
        union all select ${name} n, ${org} o, e.ZADDRESS h from ZABCDEMAILADDRESS e join ZABCDRECORD r on r.Z_PK = e.ZOWNER`)) {
        const n = row.n || row.o
        if (n && row.h && key(row.h)) names.set(key(row.h), n)
      }
    } catch {}
  }
  return names
}

/** Text of a message: the text column, or (newer macOS) the string inside the attributedBody archive. */
function textOf(row) {
  if (row.text) return row.text
  if (!row.body) return ''
  const b = Buffer.from(row.body, 'hex')
  const at = b.indexOf('NSString')
  if (at < 0) return ''
  let i = at + 'NSString'.length + 5 // class info, then 0x2B '+' and the length
  let len = b[i]; i++
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2 } else if (len === 0x82) { len = b.readUInt32LE(i); i += 4 }
  return b.subarray(i, i + len).toString('utf8')
}

const when = ns => new Date((Number(ns) / 1e9 + APPLE_EPOCH) * 1000).toISOString()
const COLS = `m.ROWID id, m.text text, hex(m.attributedBody) body, m.date date, m.is_from_me me, m.is_read read, m.cache_has_attachments att,
  h.id handle, c.display_name chat_name, c.style style`
const FROM = `from message m left join handle h on h.ROWID = m.handle_id
  left join chat_message_join cm on cm.message_id = m.ROWID left join chat c on c.ROWID = cm.chat_id`
// Real messages only: no tapbacks / reactions, no system rows.
const REAL = 'm.associated_message_type = 0 and m.item_type = 0'

function shape(rows, names) {
  return rows.map(r => {
    const text = textOf(r).replace(/￼/g, '').trim()
    return {
      from: r.me ? 'me' : (names.get(key(r.handle || '')) || r.handle || 'unknown'),
      handle: r.handle || '',
      ...(r.style === 43 ? { group: r.chat_name || 'group chat' } : {}),
      text: (text || (r.att ? '[attachment]' : '')).slice(0, 500),
      time: when(r.date),
      ...(r.me ? {} : { unread: !r.read }),
    }
  }).filter(m => m.text)
}

const int = (s, lo, hi, d) => { const n = Number.parseInt(s, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }

const args = (process.env.SSH_ORIGINAL_COMMAND ? process.env.SSH_ORIGINAL_COMMAND.trim().split(/\s+/) : process.argv.slice(2))
const [cmd, a1, a2] = args
try {
  if (cmd === 'recent') {
    const hours = int(a1, 1, 24 * 14, 24), max = int(a2, 1, 40, 15)
    const since = (Date.now() / 1000 - APPLE_EPOCH - hours * 3600) * 1e9
    const rows = sql(CHAT_DB, `select ${COLS} ${FROM} where ${REAL} and m.is_from_me = 0 and m.date > ${Math.floor(since)} order by m.date desc limit ${max}`)
    process.stdout.write(JSON.stringify(shape(rows, contacts())) + '\n')
  } else if (cmd === 'thread') {
    if (!HANDLE.test(a1 || '')) fail('handle must be a phone number or email')
    const max = int(a2, 1, 30, 12)
    const k = key(a1)
    const match = a1.includes('@') ? `lower(h.id) = ${q(k)}` : `substr(replace(replace(replace(replace(h.id,'+',''),'-',''),' ',''),'(',''), -10) = ${q(k)}`
    // Messages in one-to-one chats with this person (both directions), newest first.
    const rows = sql(CHAT_DB, `select ${COLS} from message m join chat_message_join cm on cm.message_id = m.ROWID join chat c on c.ROWID = cm.chat_id
      join chat_handle_join ch on ch.chat_id = c.ROWID join handle h on h.ROWID = ch.handle_id
      where ${REAL} and c.style = 45 and ${match} order by m.date desc limit ${max}`)
    process.stdout.write(JSON.stringify(shape(rows, contacts()).reverse()) + '\n')
  } else if (cmd === 'who') {
    const name = (args.slice(1).join(' ') || '').trim().toLowerCase()
    if (!/^[\p{L}\p{M} .'-]{2,40}$/u.test(name)) fail('name must be letters')
    const found = new Map()
    for (const [h, n] of contacts()) if (n.toLowerCase().includes(name)) { if (!found.has(n)) found.set(n, []); found.get(n).push(h) }
    // Each person's numbers and emails, the one you last texted with first (a contact card often lists old numbers),
    // then numbers before emails.
    const last = new Map()
    for (const r of sql(CHAT_DB, 'select h.id id, max(m.date) d from handle h join message m on m.handle_id = h.ROWID group by h.id')) {
      const k = key(r.id || '')
      if (k && (last.get(k) ?? 0) < r.d) last.set(k, r.d)
    }
    const ranked = hs => [...hs].sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0) || Number(a.includes('@')) - Number(b.includes('@')))
    process.stdout.write(JSON.stringify([...found].slice(0, 8).map(([n, hs]) => ({ name: n, handles: ranked(hs).slice(0, 4) }))) + '\n')
  } else if (cmd === 'send') {
    if (!HANDLE.test(a1 || '')) fail('handle must be a phone number or email')
    const body = readFileSync(0, 'utf8').trim()
    if (!body || body.length > 1000) fail('text must be 1-1000 characters')
    // iMessage first; SMS (through the iPhone) if the number isn't on iMessage.
    const script = `on run argv
      set {who, msg} to {item 1 of argv, item 2 of argv}
      tell application "Messages"
        try
          send msg to participant who of (1st account whose service type = iMessage)
          return "iMessage"
        on error
          send msg to participant who of (1st account whose service type = SMS)
          return "SMS"
        end try
      end tell
    end run`
    const via = execFileSync('/usr/bin/osascript', ['-e', script, a1, body], { encoding: 'utf8', timeout: 20_000 }).trim()
    process.stdout.write(JSON.stringify({ sent: true, via }) + '\n')
  } else fail('unknown command')
} catch (e) {
  fail(String(e?.stderr || e?.message || e).split('\n')[0].slice(0, 200))
}
