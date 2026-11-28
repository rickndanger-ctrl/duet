// "Hey Duet" detection on Whisper transcripts of short utterances.
// Whisper hears the name many ways; anything that sounds like it at the start counts.
// Returns null (not a wake) or the words after the wake phrase ('' when there are none).

const NAME = String.raw`(?:duet+e?|du[- ]?et|due[- ]?(?:it|et|at|ette?)|dewitt?|do[- ]?et|dueth?|douet|duette|juet|tuet|the[- ]?wet|dwet)`;
const GREETING = String.raw`(?:hey|hi|hello|ok(?:ay)?|yo|a|hay|eh|ay)`;
// "hey duet ..." or "duet, ..." at the start. "do it" alone is too common to count, but "hey do it" is accepted.
const WAKE = new RegExp(String.raw`^\s*(?:(?:${GREETING})[\s,.!-]+(?:${NAME}|do[- ]it)|${NAME})(?=$|[\s,.!?:;-])[\s,.!?:;-]*`, 'i');

export function matchWake(transcript: string): string | null {
  const text = transcript.normalize('NFKC').replace(/[‘’]/g, "'").trim();
  const m = WAKE.exec(text);
  if (!m) return null;
  return text.slice(m[0].length).trim();
}

/** Whisper's well-known phantom outputs on silence or noise. */
const PHANTOMS = /^(?:thanks? (?:you )?(?:for watching|so much)?|thank you\.?|you|bye\.?|\.+|okay\.?|so\.?|uh+\.?|um+\.?|hmm+\.?|music|\[.*\]|\(.*\))[.!\s]*$/i;

/** Whether a transcript is something someone actually said to Duet. */
export function isRealSpeech(transcript: string): boolean {
  const t = transcript.trim();
  if (!t) return false;
  if (PHANTOMS.test(t)) return false;
  return /[a-z0-9]/i.test(t);
}

/** A spoken yes or no to "Send? / Add? / Move?". null = neither (keep waiting). */
export function yesNo(transcript: string): boolean | null {
  const t = transcript.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^(no|nope|nah|don't|do not|cancel|stop|wait|hold on|never ?mind|not yet|not now)\b/.test(t)) return false;
  if (/^(yes|yeah|yep|yup|yes please|sure|send|send it|do it|go|go ahead|confirm|correct|that's right|sounds good|perfect|please do|add it|move it|absolutely|of course)\b/.test(t)) return true;
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Words that only say yes or no (or "don't send it"); anything else after a "no" is a change. */
const PLAIN = /\b(?:no|nope|nah|don't|do not|send|it|that|this|cancel|stop|wait|hold on|never ?mind|forget it|not yet|not now|thanks|thank you|please|yes|yeah|yep|sure|okay|ok|go|ahead)\b/g;

/**
 * The wearer's answer to "Send? yes / no". A change ("no, say 20 minutes instead", "yes, but make it Friday")
 * comes back as ok=false with the words, so Claude can redraft instead of sending the wrong thing. null = neither.
 */
export function confirmReply(transcript: string): { ok: boolean; change?: string } | null {
  const ok = yesNo(transcript);
  // A whole sentence that is neither yes nor no ("so there were a lot of bugs...") is the wearer talking:
  // don't sit on it until the draft times out. It goes to Claude, and nothing is sent.
  if (ok === null) return isRealSpeech(transcript) && norm(transcript).split(' ').length >= 3 ? { ok: false, change: transcript.trim().slice(0, 300) } : null;
  const t = norm(transcript);
  const extra = t.replace(PLAIN, ' ').split(' ').filter(Boolean).length;
  const change = ok ? /\b(?:but|instead|actually|change|except|rather|make it|add|also)\b/.test(t) : extra >= 2;
  return change ? { ok: false, change: transcript.trim().slice(0, 300) } : { ok };
}

/** Short replies people really say after an answer ("Okay." "Thanks!" "Why?"). Whisper also invents some of these
 *  from noise, so they count only when the microphone heard enough speech (see Duet). */
export function isShortReply(transcript: string): boolean {
  return /^(?:okay|ok|alright|all right|thanks|thank you|cool|great|perfect|nice|awesome|sure|yes|yeah|yep|no|nope|why|what|really|right|got it|sounds good)[.!?,\s]*$/i.test(transcript.trim());
}

/** "Pause", "stop listening", "that's all"...: the wearer wants Duet to stop listening for now. Short phrases only. */
export function isPause(transcript: string): boolean {
  const t = transcript.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 5) return false;
  return /^(?:(?:ok(?:ay)?|hey duet|duet) )?(?:pause|stop listening|that's all|that's it|thanks duet|thank you duet|go to sleep|sleep|stop|we're done|i'm done)\b/.test(t);
}

// ---- the wake word per app --------------------------------------------------------------------------------------
/** A wake word: what the lens calls it, how a transcript is matched, and how "pause" is said with it. */
export interface WakeWord {
  /** As shown on the lens and the phone ("Hey Duet"). */
  label: string;
  /** null = not a wake; otherwise the words after it ('' when there are none). */
  match: (transcript: string) => string | null;
  isPause: (transcript: string) => boolean;
}

/** Duet: "Hey Duet" (matchWake / isPause above, unchanged). */
export const HEY_DUET: WakeWord = { label: 'Hey Duet', match: matchWake, isPause };

// "Hey Muse" for the Muse build (Hey Muse). Whisper (large-v3-turbo, 10 macOS voices, 50 clips, 2026-11-27) wrote Muse 42 times,
// "Mews" 5 times, and once each "News, …" and "Musay, …" for the bare name. After a greeting the looser spellings count;
// on its own only the close ones do ("News" at the start of a sentence is too common to wake on).
// Built on first use, so Duet's build doesn't carry it.
let museWake: RegExp | undefined;
function museWakeRe(): RegExp {
  const name = String.raw`(?:muse|mews|muze|meuse|musay|musee|mus)`;
  const loose = String.raw`(?:${name}|news|moose|mues|mewse|muses|music)`;
  return museWake ??= new RegExp(String.raw`^\s*(?:(?:${GREETING})[\s,.!-]+${loose}|${name})(?=$|[\s,.!?:;-])[\s,.!?:;-]*`, 'i');
}

export function matchMuseWake(transcript: string): string | null {
  const text = transcript.normalize('NFKC').replace(/[‘’]/g, "'").trim();
  const m = museWakeRe().exec(text);
  if (!m) return null;
  return text.slice(m[0].length).trim();
}

/** "Pause", "thanks Muse"…: as isPause, with Muse's name. Also a short sentence that ends in a goodbye ("Alright Muse,
 *  you can end the phone call if you want", "Okay, talk to you later"): people end a talk with Muse like a call. */
export function isMusePause(transcript: string): boolean {
  const t = transcript.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const n = t.split(' ').length;
  if (n <= 5 && /^(?:(?:ok(?:ay)?|hey muse|muse) )?(?:pause|stop listening|that's all|that's it|thanks muse|thank you muse|go to sleep|sleep|stop|we're done|i'm done)\b/.test(t)) return true;
  return n <= 12 && /(?:end (?:the |this |our )?(?:phone )?(?:call|conversation|chat)|hang up|good ?bye|bye(?: bye)?|talk (?:to you )?later|good ?night|that's all for now|catch you later)(?: now| for now| muse| then| if you want| please)*$/.test(t);
}

export const HEY_MUSE: WakeWord = { label: 'Hey Muse', match: matchMuseWake, isPause: isMusePause };
