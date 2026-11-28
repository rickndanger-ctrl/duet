import { defineConfig } from 'vite';
// The Muse build (VITE_DUET_BRAIN=muse) also has the voice-only page, voice.html; the default Duet build is unchanged.
const muse = process.env.VITE_DUET_BRAIN === 'muse';
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5190, strictPort: true },
  ...(muse ? { build: { rollupOptions: { input: { main: 'index.html', voice: 'voice.html' } } } } : {}),
});
