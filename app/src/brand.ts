// Which assistant this build talks to. Duet (the default) is Claude; `VITE_DUET_BRAIN=muse` builds Hey Muse (package com.piebird.duetmuse), a separate
// glasses app (its own package, server and buddy) that asks Rick's Muse instead. Everything else (the voice loop, the
// lens layout) is the same code. Vite replaces the env value at build time, so each build carries only its own brand.
import { CLAUDE_ART, type Art } from './mascot';
import { MUSE_GUY_ART } from './museguy';
import { HEY_DUET, HEY_MUSE, type WakeWord } from './wake';

export interface Brand {
  /** The app's name (phone page, menu). */
  app: string;
  /** Who answers. */
  assistant: string;
  tagline: string;
  /** Default server when none is configured (development). */
  devServer: string;
  /** Saved-settings key on the phone. */
  storageKey: string;
  art: Art;
  wake: WakeWord;
  /** Conversation timing for this assistant (see DuetDeps); Duet uses the defaults. */
  loop?: { talkEndSilenceMs?: number; shortRepliesOnlyIfAsked?: boolean };
  /** Whether the server's /health says the assistant is reachable, and what "Test connection" says when it isn't. */
  ready: (health: Record<string, unknown>) => boolean;
  missing: string;
}

const CLAUDE: Brand = {
  app: 'Duet', assistant: 'Claude', tagline: 'Claude in your G2. Talk, read, talk back.',
  devServer: 'http://127.0.0.1:5191', storageKey: 'duet', art: CLAUDE_ART, wake: HEY_DUET, ready: h => Boolean(h.claude), missing: 'no Claude key!',
};

const MUSE: Brand = {
  app: 'Hey Muse', assistant: 'Muse', tagline: 'Your Muse in your G2. Talk, read, talk back.',
  devServer: 'http://127.0.0.1:5192', storageKey: 'duetmuse', art: MUSE_GUY_ART, wake: HEY_MUSE,
  // Muse takes ~6-8 s to answer and a question typed into it can't be taken back: wait a bit longer before sending (you
  // were cut off mid-sentence at 1 s), and don't spend a turn on a lone "yeah".
  loop: { talkEndSilenceMs: 1600, shortRepliesOnlyIfAsked: true }, ready: h => Boolean(h.muse), missing: 'no Muse relay!',
};

export const BRAND: Brand = import.meta.env.VITE_DUET_BRAIN === 'muse' ? MUSE : CLAUDE;
