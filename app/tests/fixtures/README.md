# Test audio

16 kHz, 16-bit little-endian mono PCM (what the G2 glasses send), used by `tests/real.test.ts`.

| File | What it is |
|---|---|
| `next.pcm` | "Hey Duet, what's my next meeting?" (macOS `say`, Samantha) |
| `think.pcm` | "Text Sam that the new onboarding mockups look really good to me," then 2.6 s of silence, then "and that I'll bring the pie samples to the review." |
| `sure.pcm` | "Sure." |
| `talker.pcm` | Someone else talking (macOS `say`, Daniel): a made-up paragraph about sourdough, played as the background talker |
| `squeak.pcm` | A synthetic door squeak (not a voice) |

All speech is synthetic and made up for these tests; no real person's voice or conversation is included.
