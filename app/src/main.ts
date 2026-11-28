// Duet: wiring between the glasses, the conversation loop, the server and the phone page.
import './style.css';
import * as api from './api';
import { Duet, DEFAULT_SETTINGS } from './duet';
import { Glasses, type MenuItem } from './glasses';
import type { Phase, Turn } from './screen';
import { animation } from './mascot';

const MENU_WAKE = 1, MENU_NEW = 2, MENU_CLOSE = 3;

const env = import.meta.env as Record<string, string | undefined>;
// Served by the Duet server itself (…/app/), the API is one level up; in development it's the local server.
const sameServer = location.protocol === 'https:' && /\/app\/(index\.html)?$/.test(location.pathname) ? new URL('../', location.href).href : '';
const server: api.ServerConfig = { url: env.VITE_DUET_URL || sameServer || 'http://127.0.0.1:5191', token: env.VITE_DUET_TOKEN || '' };

// ---- phone page -------------------------------------------------------------
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><h1>Duet</h1><p class="sub">Claude in your G2. Talk, read, talk back.</p></header>
  <section class="card" id="state-card"><div class="row"><span id="phase" class="pill">starting</span><span id="meter"><i></i></span></div>
    <div id="live" class="live">Open Duet on your glasses.</div></section>
  <section class="card"><h2>How to use it</h2>
    <ol><li>Say <b>"Hey Duet"</b> (or tap the touch strip / ring).</li><li>Ask anything. Stop talking and it sends.</li>
    <li>Read the answer, then just talk back. No buttons.</li><li>Double tap to end. Swipe to scroll a long answer.</li></ol></section>
  <section class="card"><h2>Settings</h2>
    <label class="toggle"><input type="checkbox" id="wake"> "Hey Duet" wake word</label>
    <label>Mic sensitivity <span id="sens-v"></span><input type="range" id="sens" min="1" max="10" step="1"></label>
    <label>Wait for your reply <span id="follow-v"></span><input type="range" id="follow" min="5" max="60" step="5"></label>
    <details><summary>Server</summary>
      <label>URL<input id="url" autocomplete="off" spellcheck="false"></label>
      <label>Token<input id="token" type="password" autocomplete="off"></label>
      <button id="test">Test connection</button> <span id="test-r"></span></details></section>
  <section class="card"><h2>Conversation</h2><div id="log" class="log"></div>
    <button id="new">New conversation</button></section>
  <details class="card"><summary>Diagnostics</summary><pre id="diag"></pre></details>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const diagLines: string[] = [];
function log(line: string): void {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  diagLines.push(`${stamp} ${line}`);
  if (diagLines.length > 120) diagLines.shift();
  $('diag').textContent = diagLines.slice().reverse().join('\n');
  console.log('[duet]', line);
}

const PHASE_TEXT: Record<Phase, string> = {
  asleep: 'asleep: tap to talk', armed: 'waiting for "Hey Duet"', listening: 'listening', hearing: 'hearing you', transcribing: 'got it',
  thinking: 'thinking', working: 'working', answering: 'answering', 'your-turn': 'your turn: just talk', confirm: 'waiting for your yes / no', error: 'error',
};

// Finished turns for the phone log (the live one is drawn separately).
const finished: Turn[] = [];
let liveTurn: Turn | null = null;
function drawLog(): void {
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const all = liveTurn && !finished.includes(liveTurn) ? [...finished, liveTurn] : finished;
  $('log').innerHTML = all.slice(-20).map(t => `<p class="you">${esc(t.you)}</p><p class="duet">${esc(t.duet) || '…'}</p>`).join('');
}

// ---- glasses + loop -----------------------------------------------------------
let duet: Duet;
const menu = (): MenuItem[] => [
  { id: MENU_WAKE, name: `Hey Duet: ${duet?.settings.wakeWord ?? true ? 'on' : 'off'}` },
  { id: MENU_NEW, name: 'New conversation' },
  { id: MENU_CLOSE, name: 'Close Duet' },
];

let place = '';
let meterAt = 0;
const glasses = new Glasses({
  onGesture: g => duet.gesture(g),
  onMenu: id => {
    if (id === MENU_WAKE) setWake(!duet.settings.wakeWord);
    else if (id === MENU_NEW) newConversation();
    else if (id === MENU_CLOSE) void glasses.close();
  },
  onAudio: pcm => duet.audio(pcm),
  onForeground: front => duet.foreground(front),
  onClosed: () => { $('phase').textContent = 'closed on the glasses'; },
  onLog: log,
}, []);

duet = new Duet({
  show: (text, now, marks) => glasses.show(text, now, marks),
  clock: text => glasses.clock(text),
  mic: on => glasses.microphone(on),
  transcribe: (pcm, mode, signal) => api.transcribe(server, pcm, mode, signal),
  chat: (conversation, text, context, onEvent, signal) => api.chat(server, conversation, text, context, onEvent, signal),
  confirm: (id, ok, change) => api.confirm(server, id, ok, change),
  context: () => (refreshPlace(), { time: new Date().toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', timeZoneName: 'short' }), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(place ? { place } : {}) }),
  log,
  onTurn: (turn, phase) => {
    liveTurn = turn;
    if (phase === 'your-turn' && !finished.includes(turn)) finished.push(turn);
    drawLog();
  },
  onPhase: p => {
    console.debug('[duet] phase', p); // for automated runs (the simulator's console API)
    animateBuddy(p);
    $('phase').textContent = PHASE_TEXT[p];
    $('phase').dataset.phase = p;
    $('live').textContent = duet?.turn ? `» ${duet.turn.you}` : PHASE_TEXT[p];
  },
  onLevel: (level, speaking) => {
    const t = performance.now();
    if (t - meterAt < 80) return;
    meterAt = t;
    const bar = $('meter').firstElementChild as HTMLElement;
    bar.style.width = `${Math.round(Math.min(1, level * 4) * 100)}%`;
    bar.classList.toggle('on', speaking);
  },
});

// The buddy in the corner of the lens acts out the phase.
let buddyTimer: ReturnType<typeof setInterval> | undefined;
function animateBuddy(p: Phase): void {
  clearInterval(buddyTimer);
  const { poses, ms } = animation(p);
  let i = 0;
  glasses.buddy(poses[0]);
  if (poses.length > 1) buddyTimer = setInterval(() => glasses.buddy(poses[++i % poses.length]), ms);
}

// ---- settings ---------------------------------------------------------------
async function save(): Promise<void> {
  await glasses.storage.set('duet.settings', JSON.stringify({ ...duet.settings, url: server.url, token: server.token }));
}
function setWake(on: boolean): void {
  duet.setWakeWord(on);
  ($('wake') as HTMLInputElement).checked = on;
  glasses.setMenu(menu());
  void save();
}
function newConversation(): void {
  finished.length = 0; liveTurn = null; drawLog();
  duet.newConversation();
}
function drawSettings(): void {
  ($('wake') as HTMLInputElement).checked = duet.settings.wakeWord;
  ($('sens') as HTMLInputElement).value = String(duet.settings.sensitivity);
  $('sens-v').textContent = String(duet.settings.sensitivity);
  ($('follow') as HTMLInputElement).value = String(duet.settings.followUpMs / 1000);
  $('follow-v').textContent = `${duet.settings.followUpMs / 1000} s`;
  ($('url') as HTMLInputElement).value = server.url;
  ($('token') as HTMLInputElement).value = server.token;
}
$('wake').addEventListener('change', e => setWake((e.target as HTMLInputElement).checked));
$('sens').addEventListener('input', e => { duet.setSensitivity(Number((e.target as HTMLInputElement).value)); drawSettings(); void save(); });
$('follow').addEventListener('input', e => { duet.settings.followUpMs = Number((e.target as HTMLInputElement).value) * 1000; drawSettings(); void save(); });
$('url').addEventListener('change', e => { server.url = (e.target as HTMLInputElement).value.trim(); void save(); });
$('token').addEventListener('change', e => { server.token = (e.target as HTMLInputElement).value.trim(); void save(); });
$('new').addEventListener('click', newConversation);
$('test').addEventListener('click', async () => {
  $('test-r').textContent = '…';
  try {
    const h = await api.health(server);
    $('test-r').textContent = h.ok ? `OK${h.claude ? '' : ' (no Claude key!)'}${h.stt ? '' : ' (no speech key!)'}` : 'not OK';
  } catch (e) { $('test-r').textContent = `failed: ${(e as Error).message}`; }
});

// ---- start --------------------------------------------------------------------
async function boot(): Promise<void> {
  const ok = await glasses.connect();
  try {
    const saved = JSON.parse((await glasses.storage.get('duet.settings')) || '{}');
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) if (saved[k] !== undefined) (duet.settings as unknown as Record<string, unknown>)[k] = saved[k];
    duet.setSensitivity(duet.settings.sensitivity);
    if (saved.url) server.url = saved.url;
    if (saved.token) server.token = saved.token;
  } catch { /* first run */ }
  drawSettings();
  glasses.setMenu(menu());
  duet.start();
  if (!ok) { $('phase').textContent = 'glasses not connected'; setTimeout(() => void boot(), 5000); return; }
  void refreshPlace(true);
}

// Rough location (about 10 km) so "what's the weather" just works. Asked at start and again on later turns
// (at most every few minutes) if it wasn't ready; the last one is kept so a restart still has it.
let placeAt = 0;
async function refreshPlace(force = false): Promise<void> {
  if (!place) place = await glasses.storage.get('duet.place');
  if (!force && Date.now() - placeAt < 5 * 60_000) return;
  placeAt = Date.now();
  const at = await glasses.location();
  if (!at) { log('location not available'); return; }
  place = `around latitude ${at.lat.toFixed(1)}, longitude ${at.lon.toFixed(1)}`;
  void glasses.storage.set('duet.place', place);
}
void boot();
