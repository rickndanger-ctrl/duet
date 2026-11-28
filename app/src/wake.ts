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
  if (ok === null) return null;
  const t = norm(transcript);
  const extra = t.replace(PLAIN, ' ').split(' ').filter(Boolean).length;
  const change = ok ? /\b(?:but|instead|actually|change|except|rather|make it|add|also)\b/.test(t) : extra >= 2;
  return change ? { ok: false, change: transcript.trim().slice(0, 300) } : { ok };
}

/** "Pause", "stop listening", "that's all"...: the wearer wants Duet to stop listening for now. Short phrases only. */
export function isPause(transcript: string): boolean {
  const t = transcript.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 5) return false;
  return /^(?:(?:ok(?:ay)?|hey duet|duet) )?(?:pause|stop listening|that's all|that's it|thanks duet|thank you duet|go to sleep|sleep|stop|we're done|i'm done)\b/.test(t);
}
