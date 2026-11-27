// Client for the Duet server: speech-to-text and Claude's streamed answer.

export interface ServerConfig { url: string; token: string }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type ChatEvent = { t: 'delta'; text: string } | { t: 'search' } | { t: 'done' } | { t: 'error'; message: string };

const base = (cfg: ServerConfig) => cfg.url.replace(/\/+$/, '');
const auth = (cfg: ServerConfig): Record<string, string> => (cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {});

export async function health(cfg: ServerConfig): Promise<{ ok: boolean; claude?: boolean; stt?: boolean; model?: string }> {
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

/** Streams Claude's answer. Resolves when the stream ends; events arrive through onEvent. */
export async function chat(cfg: ServerConfig, messages: ChatMessage[], context: Record<string, string>, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${base(cfg)}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(cfg) },
    body: JSON.stringify({ messages, context }),
    signal,
  });
  if (res.status === 401) throw new Error('server token is wrong');
  if (!res.ok || !res.body) throw new Error(`Claude request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6)) as ChatEvent;
          if (event.t === 'done' || event.t === 'error') ended = true;
          onEvent(event);
        } catch { /* a broken line is skipped */ }
      }
    }
  }
  if (!ended) onEvent({ t: 'error', message: 'the answer was cut off' });
}
