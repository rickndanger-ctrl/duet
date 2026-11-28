# Hey Muse (package `com.piebird.duetmuse`, first released as "Duet Muse")

A second glasses app built from the same code as Duet: the same hands-free voice loop ("Hey Muse", the end of your sentence
sends it, "pause" or a double tap stops listening, RNNoise ignores non-voice sounds) and the same lens layout. The answers
come from a Muse agent on a Mac instead of Claude. It's a separate app with its own package (`com.piebird.duetmuse`), its own
server, its own wake word and its own buddy on the lens: Musa, Rick's own Muse character, made from his art
(`scripts/musa-sprite.mjs` turns the master image into `app/src/musa-pixels.ts`; `app/src/museguy.ts` draws the poses).
Duet itself is unchanged.

```
G2 mic → app (VITE_DUET_BRAIN=muse build) → server/muse-server.mjs → /v1/stt (Groq Whisper, as in Duet)
                                                                    → a Muse relay: /selftest, /ask, /reply/:id, /latest
```

## How an answer is read

The relay types the question into Muse's window and reads the window back. It treats a reply as finished once the text
stops changing for about a second. Muse shows "Musa / is working" while it thinks, so on its own the relay can hand back
that stub. Hey Muse reads Muse's side card instead (`server/muse-reply.mjs`): the answer is done when the card's state
is back to "Connected" and the answer has stopped changing. Once the relay has closed its job, Hey Muse reads the relay's
read-only `/latest` until then. The relay itself is not changed.

- **Muse 14.1** (2026-11-27) no longer shows the card or the stub in the window text: after the question there is nothing
  until the answer appears. Then Hey Muse goes by the answer staying the same over a few reads after the relay is done
  (about 3 s), so an answer arrives about 6-7 s after you stop talking. The card logic stays for when the card is there.
- **Approvals** happen in Muse's window. While one waits (the card's state says so, or the newest "Approvals history" row
  has no outcome yet), the lens says `approve it on <Mac>…`.
- **Answers aren't streamed**: Muse's window text can change anywhere while it writes, and the lens only takes text added
  at the end, so the answer appears once it's complete.
- **Not ready**: if Muse's text box isn't ready, or the relay fails before typing anything, Hey Muse asks once more and
  then shows a short error (`Muse box not ready`, `Muse didn't type it`). Nothing is typed twice.
- **Speech to text**: Groq's free tier allows 2000 transcriptions a day per account, and listening for "Hey Muse" sends
  every phrase heard in the room. With `DUET_LOCAL_STT_URL` set (a whisper.cpp `whisper-server`, e.g. with `ggml-base.en`),
  the wake checks run locally (~0.1 s, no quota) and questions go to Groq, falling back to the local one when Groq refuses.
  On the local model "Hey Muse" matched 46 of 50 test clips (Groq: 49).
- A short note is added to each question so Muse answers briefly in plain text (`DUET_MUSE_NOTE`, '' turns it off).

## Run it

```bash
# Server (Node 20+, no npm dependencies). Config in ~/.config/duet-muse:
#   token      the app's password        (openssl rand -hex 24 > token)
#   groq.key   speech-to-text
#   muse.json  [{"name": "My Mac", "url": "https://<relay host>/muse", "tokenFile": "<file with the relay's token>"}]
#              tried in order; a later one is used only when an earlier one isn't ready
node server/muse-server.mjs        # http://127.0.0.1:5192, also served under /duet-muse

# App
cd app && npm run check:muse       # tests + build into dist-muse/
DUET_MUSE_URL=https://your-server/duet-muse DUET_MUSE_TOKEN=$(cat ~/.config/duet-muse/token) ../scripts/pack-muse.sh
#   → app/duetmuse-0.2.0.ehpk
```

The store icon is `app/icon-muse.png`, drawn by `scripts/muse-icon.mjs` (Even Hub wants 24x24, opaque #F4F4F4).

## Voice page for glasses without a display

For glasses with no lens (microphone and speaker only), `app/voice.html` is a page that listens for "Hey Muse", asks, and reads
the answer aloud. It is built into `app/dist-muse` next to the app. Set `DUET_MUSE_WEB_DIR` to the folder holding it and the
server serves it under `/web/` (also `/duet-muse/web/`), with no token: only the page's static files are public, the API
still needs the token. Unset, there is no `/web/` route. The page sends `spoken: true` with `/v1/chat`; for that turn the
server types `DUET_MUSE_SPOKEN_NOTE` (default: 1 to 3 short sentences, no lists, links, code or symbols) instead of
`DUET_MUSE_NOTE`, and the approval status becomes a sentence to speak ("Muse needs your approval on <name>."). Follow-ups in the same conversation
keep the spoken note.

## Rebranding

Everything Muse-specific is in a few places: `MUSE` in `app/src/brand.ts` (name, tagline, wake word, buddy),
`app/src/museguy.ts` (the buddy on the lens and the gutter mark; the earlier round spirit is `MUSE_ART` in `mascot.ts`),
`HEY_MUSE` in `app/src/wake.ts` (wake word, measured on Whisper in `tests/fixtures/hey-muse-whisper.txt`), the status texts in `server/muse-server.mjs`,
`app/app.muse.json` (package name) and the icon script.

While the file `~/.config/duet-muse/debug` exists, transcripts and questions are logged (off by default).
