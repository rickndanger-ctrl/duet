# Duet: talk with Claude through your Even G2

**Track 04 · AI Assistants & Work** (Claude + Google Calendar + Gmail + text messages)

Duet is a hands-free conversation with Claude on Even Realities G2 glasses. You speak, Claude's answer
appears on the lens, and you **just talk back**: no button between turns. It can also act on your day.
It reads your calendar, mail and texts, drafts replies, sends texts and moves meetings. Nothing is sent or changed until
you say **"yes"** to the exact draft on the lens.

```
 you:  "Hey Duet, anything from Sam?"
 lens: DUET · checking your mail…
 lens: Sam asks if lunch Friday at noon is still on.
 you:  "Tell him yes, see you there"
 lens: DUET · Send?  yes / no
       Reply to Sam Lee
       Re: Lunch Friday?
       "Yes! See you there at noon."
 you:  "Yes"
 lens: Sent.
```

## The problem

Asking an assistant something on the move means pulling out a phone, unlocking it, typing, reading.
Voice assistants talk back out loud, which you can't use in a meeting, a shop or next to a sleeping kid.
G2 has a private display and a microphone: the answer can be silent and only for you.

## Who it's for

Anyone wearing G2 through a working day: small-business owners on the shop floor, people walking between meetings, anyone who wants "what's next / reply to that / move it" without a screen.

## How it works

```
G2 mic (16 kHz PCM, while Duet is open)
  → voice activity detection in the app (energy, a noise floor that keeps learning   app/src/vad.ts
     the room while you talk, and your own voice level, so a fan or TV can't hold the mic open)
  → each spoken phrase → server /v1/stt → Groq Whisper (≈0.3 s)
       asleep: is it "Hey Duet …"?  (fuzzy match, the rest becomes the question)   app/src/wake.ts
       awake:  it's your turn → Claude
  → server runs the turn with Claude (claude-opus-5-5, low effort) + tools:          server/duet-server.mjs
       web search · calendar_events · gmail_search · gmail_read                       (run at once)
       messages_recent · messages_thread                                              (run at once)
       gmail_reply · gmail_send · calendar_create_event · calendar_update_event        (wait for your yes)
       messages_send                                                                  (waits for your yes)
  → app long-polls the turn: status ("checking your calendar…"), text, confirm requests
  → word-wrapped onto the 576×288 lens (8 lines, swipe to scroll)                     app/src/screen.ts
  → answer done: the mic is already open. Talk to continue; quiet for 20 s and it sleeps.  app/src/duet.ts
```

- **Lens**: top row is a short status ("TALK NOW", "HEARING YOU…", "WAIT · thinking…"), the animated Claude buddy in
  the middle, and the date and time on the right. Below, your whole message marked **ME** in the left margin, then
  Claude's answer with a tiny Claude beside it. As soon as you start talking, a "ME …" line shows that Duet hears you.
- **Wake**: say "Hey Duet" (works with the question in the same breath), or tap the temple / ring.
- **Turn-taking**: the end of your sentence (a second of silence) is the send button. Pause mid-thought and carry on
  before Claude answers, and it stays one message. Once you've been talking a few seconds, a pause to find the words
  can last 3.5 s (set 2-8 s with "Pause before sending" on the phone screen); a tap sends at once. Talking over an answer interrupts it. Short replies like "Okay."
  count when the mic clearly heard them.
- **Confirm**: every write shows the exact draft and waits. Say "yes" / "send it" or tap to confirm.
  Say "no" or double tap to cancel. No answer in 60 s means cancel. "Okay" doesn't count as yes,
  because Whisper hears it in background noise.
- **Memory**: the server keeps the conversation (tool calls included) for 30 min, so "reply to that one"
  works. In memory only; nothing is written to disk. Audio is never stored. Only speech is sent, never silence.

## Setup

Needs Node 20+, an [Anthropic API key](https://console.anthropic.com), a [Groq API key](https://console.groq.com)
(speech-to-text) and, for calendar and mail, a Google OAuth client ([docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)).
For text messages, run the server on a Mac signed in to Messages ([docs/MESSAGES_SETUP.md](docs/MESSAGES_SETUP.md)).

```bash
# 1. Server (any machine your phone can reach over HTTPS)
cd server && npm install
mkdir -p ~/.config/duet && chmod 700 ~/.config/duet
printf '%s' "$ANTHROPIC_API_KEY" > ~/.config/duet/anthropic.key
printf '%s' "$GROQ_API_KEY"      > ~/.config/duet/groq.key
openssl rand -hex 24             > ~/.config/duet/token      # the app's password for your server
chmod 600 ~/.config/duet/*
node google-auth.mjs ~/Downloads/client_secret_*.json        # optional: Calendar + Gmail
node duet-server.mjs                                         # http://127.0.0.1:5191
# put HTTPS in front (we use `tailscale serve --set-path /duet http://127.0.0.1:5191`)

# 2. App
cd ../app && npm install && npm run check                    # unit tests + build
DUET_URL=https://your-server/duet DUET_TOKEN=$(cat ~/.config/duet/token) ../scripts/pack.sh
#   → app/duet-0.1.0.ehpk for Even Hub
# or, without packaging: the server also serves the built app at https://your-server/duet/app/;
#   `npx evenhub qr -u https://your-server/duet/app/` and scan it in the Even app's developer tools
```

Try it without any keys: `DUET_FAKE=1 node duet-server.mjs` (scripted transcripts and answers, a fake
calendar and inbox), then `npm run dev` in `app/` and `npx evenhub-simulator http://127.0.0.1:5190/`.

With your own Anthropic and Groq keys but no Google or Messages: `DUET_DEMO=1 node duet-server.mjs` runs real Claude
and speech-to-text against a made-up calendar, inbox and texts ([server/demo.mjs](server/demo.mjs)); sends and moves
only change that demo data. The demo video was recorded this way: [demo/](demo/) drives the app in the simulator with
spoken clips through a virtual mic and renders the video.

The phone screen has the settings: "Hey Duet" on/off, mic sensitivity with a live level meter, how long
Duet waits for your reply, and the server URL/token.

## Built during the hackathon

Everything in this repo was written from Nov 27, 2026 on, during the hackathon. Nothing here existed before Nov 23.
It uses these existing libraries and APIs: Even Hub SDK (`@evenrealities/even_hub_sdk`), Anthropic SDK
(`@anthropic-ai/sdk`), Groq's Whisper API, Google Calendar and Gmail REST APIs, Vite and TypeScript.

## Safety and privacy

- Writes need an explicit yes on the lens, with the exact text shown. Duet has no delete scopes.
- Email headers for replies are read from Gmail itself, never taken from the model. Header values are single-line,
  so no header injection.
- The server holds the keys; the app only holds a server token. No keys in this repo.
- Audio is sent only while someone is speaking, is transcribed and dropped. Conversations live in server memory for 30 minutes.

## Feature requests for the platforms

1. **Even Hub SDK:** a low-power on-glasses wake word or "voice activity" event, so "Hey Duet" could work
   with Duet in the background without streaming the mic.
2. **Even Hub SDK:** streamed `fetch` responses delivered as they arrive in the webview (in the simulator small
   chunks are held back until the response ends, so Duet long-polls).
3. **Even Hub SDK:** a way to keep the mic open while the app isn't in front (opt-in, with an indicator).
4. **Claude API:** a speech-in endpoint (audio content blocks) would remove the separate speech-to-text hop.
5. **Gmail API:** a lightweight "draft reply suggestion" from Google's own models, to pair with confirm-on-glasses.

## Layout

```
app/       Even Hub app (TypeScript, Vite): glasses link, VAD, wake word, conversation loop, lens layout, phone page
server/    duet-server.mjs (STT, Claude turns, long-poll, confirm), tools.mjs, google.mjs, google-auth.mjs
scripts/   pack.sh: build + .ehpk with your server baked in
docs/      GOOGLE_SETUP.md
```

MIT licensed.
