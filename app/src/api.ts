// Client for the Duet server: speech-to-text and Claude's streamed answer.

/** `brain`: who answers, for error messages (default Claude). */
export interface ServerConfig { url: string; token: string; brain?: string }
export type ChatEvent =
  | { t: 'delta'; text: string }
  | { t: 'status'; text: string }
  | { t: 'confirm'; id: string; verb: string; prompt: string }
  | { t: 'done' }
  | { t: 'error'; message: string };

const base = (cfg: ServerConfig) => cfg.url.replace(/\/+$/, '');
const auth = (cfg: ServerConfig): Record<string, string> => (cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {});

export async function health(cfg: ServerConfig): Promise<{ ok: boolean; claude?: boolean; muse?: boolean; stt?: boolean; model?: string }> {
  const res = await fetch(`${base(cfg)}/health`, { signal: AbortSignal.timeout(6000) });
  return res.json();
}

export async function transcribe(cfg: ServerConfig, pcm: Uint8Array, mode: 'wake' | 'talk', signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${base(cfg)}/v1/stt?mode=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...auth(cfg) },
    body: pcm as unknown as BodyInit,
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new Error('server token is wrong');
  if (!res.ok) throw new Error(`speech-to-text failed (${res.status})`);
  return String((await res.json()).text ?? '');
}

/**
 * One turn: starts it, then long-polls for its events until it is done. Aborting the signal cancels the turn on the server.
 * (Long-poll rather than a streamed response: webviews hold small streamed chunks back.)
 */
export async function chat(cfg: ServerConfig, conversation: string, text: string, context: Record<string, string>, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${base(cfg)}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(cfg) },
    body: JSON.stringify({ conversation, text, context }),
    signal,
  });
  if (res.status === 401) throw new Error('server token is wrong');
  const who = cfg.brain ?? 'Claude';
  if (!res.ok) throw new Error(res.status === 503 ? `${who} is not set up on the server` : `${who} request failed (${res.status})`);
  const { turn } = await res.json() as { turn: string };
  const cancel = () => { void fetch(`${base(cfg)}/v1/turn/${turn}/cancel`, { method: 'POST', headers: auth(cfg) }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let after = 0;
  let misses = 0;
  try {
    for (;;) {
      let page: { events: ChatEvent[]; next: number; done: boolean };
      try {
        const r = await fetch(`${base(cfg)}/v1/turn/${turn}?after=${after}`, { headers: auth(cfg), signal });
        if (!r.ok) throw new Error(`poll ${r.status}`);
        page = await r.json();
        misses = 0;
      } catch (e) {
        if (signal.aborted) throw e;
        if (++misses >= 4) throw new Error('lost the server');
        await new Promise(r => setTimeout(r, 400 * misses));
        continue;
      }
      after = page.next;
      for (const event of page.events) {
        try { onEvent(event); } catch (e) { console.error('[duet] event handler failed', event.t, e); }
      }
      if (page.done) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** The wearer's yes/no to a confirm event; `change` is what they asked for instead ("no, say 20 minutes"). */
export async function confirm(cfg: ServerConfig, id: string, ok: boolean, change?: string): Promise<void> {
  const res = await fetch(`${base(cfg)}/v1/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(cfg) },
    body: JSON.stringify({ id, ok, ...(change ? { change } : {}) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`confirm failed (${res.status})`);
}
