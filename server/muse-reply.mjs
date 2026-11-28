// Reading Muse's window for Hey Muse. Pure functions, nothing here talks to Muse.
//
// What the Muse relay returns for an exchange (its /reply and /latest "reply") is every text in Muse's window after the
// question. Under the answer, Muse's side card follows: the agent's name ("Musa"), its state, then "Approvals history":
//
//   <answer lines…>                 (nothing yet while Muse thinks)
//   Musa
//   Connected                        ("is working" while it thinks; Connected once it's done)
//   Approvals history
//   Share a one-time code in Browser
//   The agent will see your one-time code…
//   Allowed once · 10h ago
//   …
//
// The relay calls a reply finished once its text stops changing for about a second, but "Musa / is working" can sit
// still for longer than that, so on its own it hands back the stub. Hey Muse goes by the card's state instead: the
// answer is done when the state is back to "Connected" and the answer has stopped changing.
//
// sanitizeMuseReply below is a copy of the window-chrome cleaner from another glasses app that reads the same relay
// (2026-11-27), kept as a copy on purpose: Hey Muse stays independent of it.

/** The agent's name on Muse's card. */
export const MUSE_NAME = process.env.DUET_MUSE_NAME || 'Musa'

const norm = s => String(s ?? '')
  .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/…/g, '...')
  .replace(/\s+/g, ' ').trim().toLowerCase()

/** Whether two questions are the same one (Muse's text box curls quotes and may trim spaces or a final character).
 *  A question that only starts with the other ("…recipe?" vs "…recipe? And the pecan one.") is a different one. */
export function sameQuestion(a, b) {
  const x = norm(a), y = norm(b)
  if (!x || !y) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long.startsWith(short) && long.length - short.length <= 2
}

const IDLE = /^(?:connected|ready|idle|online|done|available)$/i
const APPROVAL = /\b(?:approv\w*|permission|waiting|needs? you|confirm\w*|allow\w*|review)\b/i
/** A resolved row in "Approvals history": "Allowed once · 10h ago", "Timed out · 2m ago", "Denied · just now". */
const RESOLVED = /^(?:allowed(?: once| always)?|denied|declined|rejected|timed out|expired|cancell?ed|approved)\b.*·|·\s*(?:.+ ago|just now|yesterday)$/i
const STUB = /^(?:musa|muse)?\s*(?:is\s+)?(?:working|thinking)(?:\s+on it)?[.…]*$/i

/** A state line on the card: a few words, not a sentence. */
const stateLike = t => Boolean(t) && t.split(/\s+/).length <= 6 && !/[.!?:]$/.test(t)

/**
 * Splits what the relay returned into Muse's answer and its card.
 *   answer:   the reply text only (no card, no window chrome)
 *   state:    the card's state line ("Connected", "is working", …), '' when no card was found
 *   idle:     Muse is done (state "Connected")
 *   working:  Muse is still on it (any other state)
 *   approval: Muse waits for an approval in its window: the state says so, or the newest row in "Approvals history"
 *             has no outcome yet. Then it's the approval's label ("Share a one-time code in Browser") or the state.
 */
export function readMuse(reply, name = MUSE_NAME) {
  const lines = String(reply ?? '').replace(/\r/g, '').split('\n')
  const isName = l => l.trim().toLowerCase() === name.toLowerCase()
  const isHistory = l => /^approvals history$/i.test(l?.trim() ?? '')
  // The card: the LAST name line followed by a state line, then "Approvals history" (or nothing).
  let card = -1
  for (let k = lines.length - 2; k >= 0; k--) {
    if (!isName(lines[k]) || !stateLike(lines[k + 1].trim())) continue
    if (k + 2 >= lines.length || isHistory(lines[k + 2]) || !lines.slice(k + 2).some(l => l.trim())) { card = k; break }
  }
  const state = card >= 0 ? lines[card + 1].trim() : ''
  const answerLines = card >= 0 ? lines.slice(0, card) : lines
  let answer = sanitizeMuseReply(answerLines.join('\n'), { partial: card < 0 }).text.trim()
  if (answer === NO_TEXT || STUB.test(answer)) answer = ''
  // Without a card the stub may come through as "Musa\nis working".
  if (card < 0 && /^(?:musa|muse)\s*\n\s*is working/i.test(answer)) answer = ''

  // "Connected" means Muse is done, whatever the history shows (an outcome worded in a way we don't know must not
  // hold the answer back). Otherwise an approval waits when the state says so or the newest history row has no outcome.
  const idle = Boolean(state) && IDLE.test(state)
  let approval = ''
  if (state && !idle && APPROVAL.test(state)) approval = state
  const h = lines.findIndex(isHistory)
  if (!idle && !approval && h >= 0 && h + 1 < lines.length && lines[h + 1].trim() && !RESOLVED.test(lines[h + 1].trim())) {
    // The newest entry: a label, maybe a description, then its outcome. No outcome before the next entry = still open.
    const entry = []
    for (let i = h + 1; i < lines.length && entry.length < 3; i++) { if (lines[i].trim()) entry.push(lines[i].trim()) }
    if (!entry.some(l => RESOLVED.test(l))) approval = entry[0]
  }
  const working = Boolean(state) && !idle && !approval
  return { answer, state, idle, working, approval, card: card >= 0 }
}

// ---- copy of the shared window-chrome cleaner ------------------------------------------------------------------------
const ANCHOR_EXACT = [/^approvals history$/i, /^place this order\?$/i]
const ANCHOR_STAMP = /^allowed( once)? · .+ ago$/i
const ANCHOR_START = [/^fill saved credentials/i, /^share a one-time code/i, /^allow access to/i]
const looksLikeLabel = t => /\bin Browser$/i.test(t) || (t.split(/\s+/).length <= 6 && !/[.!?]$/.test(t))
const isAnchor = line => {
  const t = line.trim()
  return ANCHOR_EXACT.some(re => re.test(t)) || ANCHOR_STAMP.test(t) || (ANCHOR_START.some(re => re.test(t)) && looksLikeLabel(t))
}
const HEADINGS = new Set(['Status', 'Muse', 'Musa', 'Connected', 'Received'])
const isHeader = line => HEADINGS.has(line.trim())
export const NO_TEXT = 'Muse sent no text'
const FOLLOW = 6
const isStrong = line => /^approvals history$/i.test(line.trim()) || ANCHOR_STAMP.test(line.trim())
const LABEL_LITERALS = ['approvals history', 'place this order?', 'fill saved credentials', 'share a one-time code', 'allow access to']
const HEADING_LITERALS = ['status', 'muse', 'musa', 'connected', 'received']
const unfinishedLabel = t => {
  const l = t.trim().toLowerCase()
  if (!l) return false
  return LABEL_LITERALS.some(x => x.startsWith(l) && x !== l)
    || HEADING_LITERALS.some(x => x.startsWith(l))
    || (/^allowed( once)?( · .*)?$/.test(l) && !ANCHOR_STAMP.test(t.trim()))
}

/** The answer without Muse's window chrome (rules: two chrome anchors within 6 lines, see below). Adds "Musa" to the headings. */
export function sanitizeMuseReply(reply, { partial = false } = {}) {
  const original = String(reply ?? '')
  const lines = original.replace(/\r/g, '').split('\n')
  let at = -1
  const firstReal = lines.findIndex(l => l.trim())
  let lastReal = lines.length - 1
  while (lastReal >= 0 && !lines[lastReal].trim()) lastReal--
  for (let i = 0; i < lines.length; i++) {
    if (!isAnchor(lines[i]) && !(partial && i === lastReal && i !== firstReal && unfinishedLabel(lines[i]))) continue
    let second = false
    let strong = isStrong(lines[i])
    for (let j = i + 1; j < lines.length && j <= i + FOLLOW; j++) if (isAnchor(lines[j])) { second = true; if (isStrong(lines[j])) strong = true }
    if (second && !strong && !partial) continue
    if (second || partial) { at = i; break }
  }
  if (at < 0) {
    if (partial) {
      let end = lines.length
      while (end > 0 && !lines[end - 1].trim()) end--
      let stripped = end
      while (stripped - 1 > firstReal && isHeader(lines[stripped - 1])) { stripped--; while (stripped - 1 > firstReal && !lines[stripped - 1].trim()) stripped-- }
      if (stripped < end) {
        const text = lines.slice(0, stripped).join('\n').replace(/\s+$/, '')
        return { text, trimmed: original.length - text.length, anchor: lines[end - 1].trim().slice(0, 30) }
      }
    }
    return { text: original, trimmed: 0, anchor: '' }
  }
  let cut = at
  while (cut > 0 && cut - 1 !== firstReal && (isHeader(lines[cut - 1]) || !lines[cut - 1].trim())) cut--
  let text = lines.slice(0, cut).join('\n').replace(/\s+$/, '')
  if (!text.trim() && !partial) text = NO_TEXT
  return { text, trimmed: Math.max(0, original.length - text.length), anchor: lines[at].trim().slice(0, 30) }
}
