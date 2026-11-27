# Duet

Claude in your Even Realities G2, as a real conversation: **you talk, Claude answers in text on the lens,
you talk back. No buttons.**

- **"Hey Duet"** wakes it (or tap the touch strip / ring). "Hey Duet, what's a good pie for Thanksgiving?" works in one breath.
- Stop talking and it sends. Claude's answer streams onto the lens as it's written.
- When the answer is done the mic is already open: just reply. Talk over an answer to interrupt it.
- Quiet for 20 s and it goes back to waiting for "Hey Duet". Double tap ends a conversation.
- Swipe to scroll a long answer. Claude searches the web for anything current (weather, news, hours).

## How it works

```
G2 mic (16 kHz PCM) → voice detection on the phone (app/src/vad.ts)
  → speech segment → server /v1/stt (Groq Whisper) → "Hey Duet" check (app/src/wake.ts) or your question
  → server /v1/chat → Claude (claude-opus-5-5, low effort, web search), streamed back as SSE
  → word-wrapped onto the lens (app/src/screen.ts), mic stays open for your reply (app/src/duet.ts)
```

Only speech segments leave the phone; silence never does. The server keeps nothing on disk.

## Run it

Server (keys in `~/.config/duet/`: `anthropic.key`, `groq.key`, `token`):

    cd server && npm install && node duet-server.mjs          # :5191
    DUET_FAKE=1 node duet-server.mjs                          # canned answers, no keys

App:

    cd app && npm install && npm run check
    VITE_DUET_URL=https://your-server VITE_DUET_TOKEN=... npm run dev
    npx evenhub qr ...                                         # load the dev build on the phone
    npm run build && npx evenhub pack app.json dist            # .ehpk for Even Hub

The phone page has the settings: wake word on/off, mic sensitivity (with a live level meter),
how long Duet waits for your reply, and the server URL/token.
