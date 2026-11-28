# DoraHacks submission: Duet

**Track:** 04 · AI Assistants & Work (Claude, Google Workspace, text messages)
**Repo:** https://github.com/rickndanger-ctrl/duet

## Short description

**Problem.** Asking an assistant something on the move means phone out, unlock, type, read. Voice assistants
answer out loud, which doesn't work in a meeting, a shop or a quiet room.

**Who it's for.** People who wear G2 through a working day and want "what's next / reply to that / move it"
without touching a screen.

**How it works.** Say "Hey Duet" (or tap) and talk. When you stop, Claude's answer streams onto the lens, and
the mic is already open for your reply, so it's a real back-and-forth with no button between turns. Duet can act
on your day with Google Calendar, Gmail and your text messages: it briefs you on your next meeting, summarizes mail
and texts, drafts replies, texts people back and moves meetings. A glance while it's paused shows the time and date. Every action shows the exact draft on the lens and only happens after you say "yes" (or tap).
Speech-to-text is Groq Whisper (~0.3 s); Claude runs with web search and the Google tools on a small Node server
that holds the keys.

## Demo video (≤ 3 min), shot list

Film through the lens if possible (phone held behind the G2), else the simulator + a phone screen recording.

1. **0:00-0:15 Hook.** Walking, hands full. "Hey Duet, what's my next meeting?" → brief appears on the lens.
2. **0:15-0:45 Conversation with no buttons.** Follow-up straight away: "Who else is coming?" → answer.
   "Anything from them in my inbox?" → one-line summary. Point out: no taps between turns.
3. **0:45-1:20 Act by voice.** "Tell Sam I'll be ten minutes late." → lens: `Send? yes / no` with the draft.
   "Yes." → `Sent.` Show the email arriving in Gmail on a laptop.
4. **1:20-1:45 Move a meeting.** "Push my 3 o'clock to 4." → `Move? 3:00 PM → 4:00 PM` → "yes" → calendar updates.
5. **1:45-2:05 Safety.** Ask for a reply, then say "no". Nothing sent; Duet offers to change it.
5b. **Texts.** "Any texts?" → senders and gist. "Text her I'm on my way." → `Send?` with the draft → "yes".
6. **2:05-2:25 Anything else.** "Hey Duet, will it rain this afternoon?" (web search). Talk over a long
   answer to interrupt it.
7. **2:25-2:50 How it's built.** One slide: G2 mic → VAD → Whisper → Claude + tools → lens; confirm-before-write.
8. **2:50-3:00** "Duet: talk with Claude, hands-free, on G2." Repo URL.

## Feature requests (optional field)

See the README, "Feature requests for the platforms".
