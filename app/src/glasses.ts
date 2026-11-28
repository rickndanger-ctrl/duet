// Duet's link to the G2: one full-screen text box, the menu, the touch strip / ring, and the glasses microphone.
import {
  AudioInputSource,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { glassesSafe } from './screen';
import { W, H, sprite, gutter, GUTTER_W, GUTTER_H, GUTTER_ROWS, CLAUDE_ART, type Art, type Pose } from './mascot';
import type { Mark } from './screen';

export type Gesture = 'tap' | 'double' | 'up' | 'down';
export interface MenuItem { id: number; name: string }

export interface GlassesEvents {
  onGesture: (g: Gesture) => void;
  onMenu: (id: number) => void;
  onAudio: (pcm: Uint8Array) => void;
  onForeground: (inFront: boolean) => void;
  onClosed: () => void;
  onLog: (line: string) => void;
}

const BOX_ID = 1;
const BOX_NAME = 'duet-main';
const BUDDY_ID = 2;
const BUDDY_NAME = 'duet-buddy';
/** The buddy sits in the middle of the top row, over the conversation (not off in a corner). */
const BUDDY_X = 250, BUDDY_Y = 2; // the body (72 px) centered; its effects go right
/** The clock: a small text box in the top-right corner. */
const CLOCK_ID = 3;
const CLOCK_NAME = 'duet-clock';
const CLOCK_X = 344;
/** The gutter left of the conversation: two images of 4 rows each (images are at most 144 px tall). */
const GUTTER_IDS = [4, 5];
const GUTTER_NAMES = ['duet-gutter-a', 'duet-gutter-b'];
const GUTTER_X = 4, GUTTER_Y = [62, 62 + GUTTER_H];
const MAX_CHARS = 950;
/** Text updates are Bluetooth writes: at most one in flight, and no faster than this. */
const MIN_GAP_MS = 300;
const WRITE_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, what: string, ms = WRITE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Glasses {
  private sdk: EvenAppBridge | null = null;
  private ready = false;
  private inFront = true;
  private wanted = 'DUET\n\nStarting…';
  private shown: string | null = null;
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWrite = 0;
  private needRebuild = false;
  private micOn = false;
  private micQueue: Promise<unknown> = Promise.resolve();
  /** The tap that brings Duet back to the front is not meant for Duet. */
  private quietUntil = 0;
  private pressing = false;
  /** The buddy pose wanted on the lens and the one last drawn (null = not drawn since the page was built). */
  private pose: Pose = 'idle';
  private shownPose: Pose | null = null;
  private poseBytes = new Map<Pose, number[]>();
  /** The clock text wanted in the corner and the one shown. */
  private clockWanted = '';
  private clockShown: string | null = null;
  /** Gutter marks wanted / drawn, per image ('me,claude,,' style keys); null = not drawn since the page was built. */
  private gutterWanted = ['', ''];
  private gutterShown: (string | null)[] = [null, null];

  /** `art`: the buddy drawn on the lens and in the gutter (Duet: the Claude character). */
  constructor(private readonly ev: GlassesEvents, private menu: MenuItem[], private readonly art: Art = CLAUDE_ART) {}

  get connected(): boolean { return this.ready; }
  get front(): boolean { return this.inFront; }
  get microphoneOn(): boolean { return this.micOn; }

  private page(text: string) {
    return {
      containerTotalNum: 5,
      textObject: [
        new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, paddingLength: 6,
          containerID: BOX_ID, containerName: BOX_NAME, isEventCapture: 1, content: text, zOrderIndex: 1,
        }),
        new TextContainerProperty({
          xPosition: CLOCK_X, yPosition: 0, width: 576 - CLOCK_X, height: 40, borderWidth: 0, paddingLength: 6,
          containerID: CLOCK_ID, containerName: CLOCK_NAME, isEventCapture: 0, content: this.clockWanted || ' ', zOrderIndex: 2,
        }),
      ],
      imageObject: [
        new ImageContainerProperty({
          xPosition: BUDDY_X, yPosition: BUDDY_Y, width: W, height: H, containerID: BUDDY_ID, containerName: BUDDY_NAME, zOrderIndex: 3,
        }),
        ...GUTTER_IDS.map((id, i) => new ImageContainerProperty({
          xPosition: GUTTER_X, yPosition: GUTTER_Y[i], width: GUTTER_W, height: GUTTER_H, containerID: id, containerName: GUTTER_NAMES[i], zOrderIndex: 4 + i, // each container needs its own layer
        })),
      ],
      menuObject: new MenuContainerProperty({ menuItems: this.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.name })) }),
    };
  }

  async connect(): Promise<boolean> {
    try {
      this.sdk = await withTimeout(waitForEvenAppBridge(), 'Even app bridge', 15_000);
      this.sdk.onEvenHubEvent(e => this.onEvent(e));
      const text = this.wanted;
      const result = await withTimeout(this.sdk.createStartUpPageContainer(new CreateStartUpPageContainer(this.page(text))), 'Glasses startup');
      if (result === StartUpPageCreateResult.invalid) {
        // A reload can leave a page behind on the glasses: take it over.
        const ok = await withTimeout(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(text))), 'Glasses recovery');
        if (!ok) throw new Error('the glasses refused the page');
      } else if (result !== StartUpPageCreateResult.success) {
        throw new Error(`the glasses answered ${result}`);
      }
      this.ready = true;
      this.shown = text;
      this.shownPose = null;
      this.clockShown = this.clockWanted;
      this.gutterShown = [null, null];
      this.ev.onLog('glasses connected');
      this.schedule();
      return true;
    } catch (e) {
      this.ev.onLog(`glasses failed: ${msg(e)}`);
      return false;
    }
  }

  /** Change the menu (labels like "Hey Duet: on"); the page is rebuilt with it. */
  setMenu(menu: MenuItem[]): void {
    this.menu = menu;
    this.needRebuild = true;
    this.schedule();
  }

  /** Show this text. Only the newest text matters; older ones that never got out are skipped. `now` skips the pacing.
   *  `marks`: who speaks on each of the 8 body rows, drawn in the gutter right after the text. */
  show(text: string, now = false, marks: Mark[] = []): void {
    this.wanted = glassesSafe(text).slice(0, MAX_CHARS) || ' ';
    this.gutterWanted = [0, 1].map(i => marks.slice(i * GUTTER_ROWS, (i + 1) * GUTTER_ROWS).map(m => m ?? '').join(','));
    if (now) this.lastWrite = 0;
    this.schedule();
  }

  /** The clock in the top-right corner. */
  clock(text: string): void {
    if (text === this.clockWanted) return;
    this.clockWanted = text;
    this.schedule();
  }

  /** Show this buddy pose. Text always goes first; the buddy is drawn when the link is free. */
  buddy(pose: Pose): void {
    if (pose === this.pose) return;
    this.pose = pose;
    this.schedule();
  }

  private schedule(): void {
    if (!this.ready || !this.inFront || this.writing || this.timer) return;
    if (this.wanted === this.shown && !this.needRebuild && this.pose === this.shownPose && this.clockWanted === this.clockShown
      && this.gutterWanted.every((g, i) => g === (this.gutterShown[i] ?? ''))) return;
    const wait = Math.max(0, MIN_GAP_MS - (performance.now() - this.lastWrite));
    this.timer = setTimeout(() => { this.timer = undefined; void this.write(); }, wait);
  }

  private async write(): Promise<void> {
    if (!this.sdk || this.writing) return;
    if (this.wanted === this.shown && !this.needRebuild && this.shown !== null) {
      // After the text: the gutter marks (they belong to it), then the clock, then the buddy.
      const g = this.gutterWanted.findIndex((k, i) => k !== (this.gutterShown[i] ?? ''));
      if (g >= 0) return this.drawGutter(g);
      if (this.clockWanted !== this.clockShown) return this.drawClock();
      return this.drawBuddy();
    }
    const text = this.wanted;
    const rebuild = this.needRebuild || this.shown === null;
    this.writing = true;
    this.lastWrite = performance.now();
    try {
      const ok = rebuild
        ? await withTimeout(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(text))), 'page rebuild')
        : await withTimeout(this.sdk.textContainerUpgrade(new TextContainerUpgrade({ containerID: BOX_ID, containerName: BOX_NAME, content: text })), 'text update');
      if (!ok) throw new Error('the glasses refused the update');
      this.shown = text;
      if (rebuild) { this.needRebuild = false; this.shownPose = null; this.gutterShown = [null, null]; this.clockShown = this.clockWanted; }
    } catch (e) {
      this.ev.onLog(`draw failed: ${msg(e)}`);
      this.shown = null; // next time rebuild the whole page
      this.lastWrite = performance.now() + 700; // back off a little
    } finally {
      this.writing = false;
      this.schedule();
    }
  }

  /** One gutter image: the speaker marks for 4 rows. */
  private async drawGutter(i: number): Promise<void> {
    const key = this.gutterWanted[i];
    this.writing = true;
    this.lastWrite = performance.now();
    try {
      const marks = key.split(',').map(m => (m || null) as Mark);
      const bytes = await png(gutter(marks, this.art), GUTTER_W, GUTTER_H);
      const r = await withTimeout(this.sdk!.updateImageRawData(new ImageRawDataUpdate({ containerID: GUTTER_IDS[i], containerName: GUTTER_NAMES[i], imageData: bytes })), 'gutter');
      if (r !== ImageRawDataUpdateResult.success) throw new Error(String(r));
    } catch (e) {
      this.ev.onLog(`gutter failed: ${msg(e)}`);
    } finally {
      this.gutterShown[i] = key; // don't retry in a loop; the next change tries again
      this.writing = false;
      this.schedule();
    }
  }

  private async drawClock(): Promise<void> {
    const text = this.clockWanted;
    this.writing = true;
    this.lastWrite = performance.now();
    try {
      const ok = await withTimeout(this.sdk!.textContainerUpgrade(new TextContainerUpgrade({ containerID: CLOCK_ID, containerName: CLOCK_NAME, content: text || ' ' })), 'clock');
      if (!ok) throw new Error('refused');
    } catch (e) {
      this.ev.onLog(`clock failed: ${msg(e)}`);
    } finally {
      this.clockShown = text;
      this.writing = false;
      this.schedule();
    }
  }

  /** One buddy frame: a tiny grey PNG (the host converts it to the lens' 4-bit grey). */
  private async drawBuddy(): Promise<void> {
    const pose = this.pose;
    this.writing = true;
    this.lastWrite = performance.now();
    try {
      let bytes = this.poseBytes.get(pose);
      if (!bytes) { bytes = await png(sprite(pose, this.art), W, H); this.poseBytes.set(pose, bytes); }
      const r = await withTimeout(this.sdk!.updateImageRawData(new ImageRawDataUpdate({ containerID: BUDDY_ID, containerName: BUDDY_NAME, imageData: bytes })), 'buddy');
      if (r !== ImageRawDataUpdateResult.success) throw new Error(String(r));
      this.shownPose = pose;
    } catch (e) {
      this.ev.onLog(`buddy failed: ${msg(e)}`);
      this.shownPose = pose; // don't retry the same frame in a loop; the next pose change tries again
    } finally {
      this.writing = false;
      this.schedule();
    }
  }

  /** Glasses microphone on/off, one change at a time. Audio arrives via onAudio as 16 kHz s16le mono PCM. */
  microphone(on: boolean): Promise<boolean> {
    const run = async () => {
      if (!this.sdk) return false;
      if (on === this.micOn) return true;
      try {
        const ok = await withTimeout(on ? this.sdk.audioControl(true, AudioInputSource.Glasses) : this.sdk.audioControl(false), 'microphone', 8000);
        if (ok) this.micOn = on;
        this.ev.onLog(`mic ${on ? 'on' : 'off'}${ok ? '' : ' refused'}`);
        return ok;
      } catch (e) {
        this.ev.onLog(`mic ${on ? 'on' : 'off'} failed: ${msg(e)}`);
        return false;
      }
    };
    const next = this.micQueue.then(run, run);
    this.micQueue = next;
    return next;
  }

  async close(): Promise<void> {
    try { await this.sdk?.shutDownPageContainer(1); } catch { /* already closed */ }
  }

  storage = {
    get: async (key: string): Promise<string> => { try { return (await this.sdk?.getLocalStorage(key)) ?? ''; } catch { return ''; } },
    set: async (key: string, value: string): Promise<void> => { try { await this.sdk?.setLocalStorage(key, value); } catch { /* best effort */ } },
  };

  async location(): Promise<{ lat: number; lon: number } | null> {
    try {
      const at = await withTimeout(this.sdk!.getAppLocation({ timeoutMs: 8000 }), 'location', 10_000);
      return at ? { lat: at.latitude, lon: at.longitude } : null;
    } catch { return null; }
  }

  private setFront(front: boolean, why: string): void {
    if (front === this.inFront) return;
    this.inFront = front;
    this.ev.onLog(why);
    if (front) { this.quietUntil = Date.now() + 800; this.shown = null; this.shownPose = null; this.schedule(); }
    this.ev.onForeground(front);
  }

  private onEvent(event: EvenHubEvent): void {
    if (event.audioEvent) {
      const raw = event.audioEvent.audioPcm as unknown;
      const pcm = raw instanceof Uint8Array ? raw
        : Array.isArray(raw) ? Uint8Array.from(raw as number[])
        : typeof raw === 'string' ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
        : null;
      if (pcm?.length) this.ev.onAudio(pcm);
      return;
    }
    const sys = event.sysEvent;
    switch (sys?.eventType) {
      case OsEventTypeList.IMU_DATA_REPORT: return;
      case OsEventTypeList.FOREGROUND_EXIT_EVENT: this.pressing = false; return this.setFront(false, 'left the front');
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: this.pressing = false; return this.setFront(true, 'back in front');
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        this.ready = false; this.micOn = false; this.inFront = false;
        this.ev.onLog('app closed on the glasses');
        this.ev.onClosed();
        return;
    }
    if (event.menuItemClickEvent?.itemID) {
      this.setFront(true, 'menu choice');
      this.ev.onMenu(event.menuItemClickEvent.itemID);
      return;
    }
    const types = [event.sysEvent, event.textEvent, event.listEvent]
      .filter(e => e !== undefined && e !== null)
      .map(e => e!.eventType ?? OsEventTypeList.CLICK_EVENT);
    if (!types.length) return;
    if (types.includes(OsEventTypeList.LONG_PRESS_EVENT)) { this.pressing = true; return; }
    if (types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) { this.pressing = false; return; }
    if (!this.inFront) { this.setFront(true, 'input while behind: assume in front'); this.quietUntil = Date.now() + 800; return; }
    if (this.pressing || Date.now() < this.quietUntil) return;
    if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) this.ev.onGesture('double');
    else if (types.includes(OsEventTypeList.CLICK_EVENT)) this.ev.onGesture('tap');
    else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) this.ev.onGesture('up');
    else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) this.ev.onGesture('down');
  }
}

/** Grey bytes (one per pixel, w x h) to PNG file bytes. */
async function png(grey: Uint8Array, w: number, h: number): Promise<number[]> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let i = 0; i < grey.length; i++) { const v = grey[i]; img.data.set([v, v, v, 255], i * 4); }
  g.putImageData(img, 0, 0);
  const blob = await new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('png failed'))), 'image/png'));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}
