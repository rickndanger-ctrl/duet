# Demo video

`record.mjs` drives the real Duet app in the Even Hub simulator and `render.mjs` turns the recording into the video.

1. Spoken lines (`lines.txt`, `name|text`) as 48 kHz WAVs in `lines/` (e.g. macOS `say -v Samantha -o lines/next.wav --data-format=LEI16@48000 "..."`),
   and a `fan.wav` noise track. `think.wav` is think_a + 2.6 s of silence + think_b (the pause scene).
2. Server: `DUET_DEMO=1 node server/duet-server.mjs`. App: `VITE_DUET_URL=http://127.0.0.1:5191 npm run dev` in `app/`.
3. A virtual mic (PipeWire/Pulse):
   `pactl load-module module-null-sink sink_name=duet_voice` and
   `pactl load-module module-remap-source master=duet_voice.monitor source_name=duet_mic`.
4. Simulator on that mic, with automation: `PIPEWIRE_NODE=duet_mic npx evenhub-simulator --automation-port 9898 http://127.0.0.1:5190`.
5. `node demo/record.mjs` plays the lines into the mic, waits on the app's phases (simulator console API) and saves every
   lens frame (screenshot API) with a `timeline.json`. Then `node demo/render.mjs` writes `duet-demo.mp4` (ffmpeg).
