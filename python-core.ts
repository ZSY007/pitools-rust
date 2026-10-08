// Optional Python/Rust activity cores (0.1.13; development defaults to TS). The TS ActivityState
// keeps running as the authoritative fallback; when the user opts in, a private
// stdin/stdout JSONL worker computes the activity line, status dot and wakeups.
// Spawned with an explicit interpreter/executable, argument array, shell:false and a
// minimal environment. No TCP/HTTP, no automatic install, no restart loop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActivityState } from './activity.ts';
import { visibleTextTail } from './core.ts';

export const PYTHON_CORE_VERSION = '0.1.13';
export const RUST_CORE_VERSION = PYTHON_CORE_VERSION;
export type WorkerKind = 'python' | 'rust';
const PROTOCOL = 1;
const READY_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 2000;
const MAX_FRAME = 1024 * 1024;
const MAX_TEXT = 65536;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const VIEW_INTERVAL_MS = 120; // Same cadence as the host's streaming paint throttle.
const WATCHDOG_MS = 500;
const BATCH_DELAY_MS = 4;
const MAX_BATCH_EVENTS = 64;
const MAX_BATCH_BYTES = 64 * 1024; // Conservative encoded-frame bound, well below MAX_FRAME.
const PHASES = new Set(['idle', 'waiting', 'thinking', 'tool', 'done']);
const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_SCRIPT = path.join(here, 'python', 'pitools_worker.py');

export type PythonCommand = { command: string; args: string[] };
type View = { epoch: number; id: number; line: string; phase: string; failure: boolean; live: boolean; nextWakeAt: number | undefined };

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue; // Never resolve an interpreter relative to the session cwd.
    const file = path.join(dir, name);
    // Windows App Execution Aliases (WindowsApps\python.exe) fail stat/exists but lstat and spawn fine.
    try { const s = fs.lstatSync(file); if (s.isFile() || s.isSymbolicLink()) return file; } catch { /* next */ }
  }
  return undefined;
}

/** Explicit interpreter: PITOOLS_PYTHON (absolute path or bare name on PATH), else platform defaults. */
export function resolvePython(env: NodeJS.ProcessEnv = process.env, platform = process.platform): PythonCommand | undefined {
  const chosen = env.PITOOLS_PYTHON?.trim();
  if (chosen) {
    if (path.isAbsolute(chosen)) { try { fs.lstatSync(chosen); return { command: chosen, args: [] }; } catch { return undefined; } }
    if (/[\\/]/.test(chosen)) return undefined;
    const found = onPath(chosen, env) ?? (platform === 'win32' && !/\.exe$/i.test(chosen) ? onPath(`${chosen}.exe`, env) : undefined);
    return found ? { command: found, args: [] } : undefined;
  }
  const candidates: Array<[string, string[]]> = platform === 'win32' ? [['py.exe', ['-3']], ['python.exe', []], ['python3.exe', []]] : [['python3', []], ['python', []]];
  for (const [name, args] of candidates) { const found = onPath(name, env); if (found) return { command: found, args }; }
  return undefined;
}

/** Explicit trusted executable or package-local platform binary. No build/download/PATH fallback by default. */
export function resolveRust(env: NodeJS.ProcessEnv = process.env, platform = process.platform, arch = process.arch): PythonCommand | undefined {
  const chosen = env.PITOOLS_RUST_CORE?.trim();
  const executable = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (chosen) {
    if (path.isAbsolute(chosen)) return executable(chosen) ? { command: chosen, args: [] } : undefined;
    if (/[\\/]/.test(chosen)) return undefined;
    const found = onPath(chosen, env) ?? (platform === 'win32' && !/\.exe$/i.test(chosen) ? onPath(`${chosen}.exe`, env) : undefined);
    return found && executable(found) ? { command: found, args: [] } : undefined;
  }
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (!cpu) return undefined;
  const libc = platform === 'linux' ? (process.report?.getReport() as any)?.header?.glibcVersionRuntime ? 'gnu' : 'musl' : '';
  const target = platform === 'win32' ? `${cpu}-pc-windows-msvc` : platform === 'darwin' ? `${cpu}-apple-darwin` : platform === 'linux' ? `${cpu}-unknown-linux-${libc}` : undefined;
  if (!target) return undefined;
  const file = path.join(here, 'bin', target, platform === 'win32' ? 'pitools-core.exe' : 'pitools-core');
  return executable(file) ? { command: file, args: [] } : undefined;
}

export function workerEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  // -I already ignores PYTHON* variables; forward nothing that could carry tokens.
  const keep = platform === 'win32' ? ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'] : ['TMPDIR'];
  return Object.fromEntries(keep.filter(key => typeof env[key] === 'string').map(key => [key, env[key] as string]));
}

export function localParts(ms: number): [number, number, number, number, number] {
  const date = new Date(ms);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getDay(), date.getHours()];
}

const tail = (text: string) => text.slice(-301); // extractNarration needs 300 units + the one before.
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

/** One private worker process and its JSONL framing. */
export class PythonWorker {
  child: any;
  closed = false;
  python = '';
  private buffer = '';
  private requests = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armedAt = 0;
  private pending = '';
  private pendingBytes = 0;
  private deltas: any[] = [];
  private deltaBytes = 128;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private batchEvents = false;
  private compactDeltas = false;
  private deltaCount = 0;
  private packIndex = new Map<string, number>();
  private flushQueued = false;
  private cancelStart: (() => void) | undefined;
  private onView: (view: View) => void;
  private onFail: (category: string) => void;
  readonly backend: WorkerKind;
  constructor(onView: (view: View) => void, onFail: (category: string) => void, backend: WorkerKind = 'python') { this.onView = onView; this.onFail = onFail; this.backend = backend; }
  start(command: PythonCommand, locale: string, script = WORKER_SCRIPT): Promise<string> {
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = (category: string) => {
        if (this.closed) return;
        this.cancelStart = undefined;
        clearTimeout(readyTimer);
        this.stop();
        if (ready) this.onFail(category); else reject(new Error(category));
      };
      let child;
      try {
        child = spawn(command.command, this.backend === 'python' ? [...command.args, '-I', '-B', script] : command.args, { cwd: os.tmpdir(), env: workerEnv(), shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch { return reject(new Error('spawn_failed')); }
      this.child = child;
      child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
      const readyTimer = setTimeout(() => fail('ready_timeout'), READY_TIMEOUT_MS); // Ref'd: bounded, settles the start promise.
      this.cancelStart = () => { clearTimeout(readyTimer); reject(new Error('stopped')); };
      child.on('error', () => { clearTimeout(readyTimer); fail('spawn_failed'); });
      child.on('exit', () => { clearTimeout(readyTimer); fail(ready ? 'exited' : 'exited_before_ready'); });
      child.stdin.on('error', () => fail('pipe_closed'));
      child.stderr.on('data', () => { /* Diagnostics only; never parsed or surfaced verbatim. */ });
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      child.stdout.on('end', () => { try { decoder.decode(); } catch { fail('bad_utf8'); } });
      child.stdout.on('data', (chunk: Buffer) => {
        try { this.buffer += decoder.decode(chunk, { stream: true }); } catch { return fail('bad_utf8'); }
        if (this.buffer.length > MAX_FRAME / 3 && !this.buffer.includes('\n') && Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME) return fail('frame_too_large');
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          let line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.length > MAX_FRAME / 3 && Buffer.byteLength(line, 'utf8') > MAX_FRAME) return fail('frame_too_large');
          if (!line.trim()) continue;
          let message: any;
          try { message = JSON.parse(line); } catch { return fail('bad_json'); }
          if (!message || typeof message !== 'object' || message.protocol !== PROTOCOL) return fail('protocol_mismatch');
          if (!ready) {
            if (message.type === 'ready' && message.version === PYTHON_CORE_VERSION && typeof message[this.backend] === 'string' && (this.backend !== 'rust' || message.core === 'rust')) {
              if (this.backend === 'rust' && message.unicode !== process.versions.unicode) return fail('unicode_mismatch');
              ready = true; clearTimeout(readyTimer); this.cancelStart = undefined; this.python = message[this.backend].slice(0, 32);
              this.batchEvents = Array.isArray(message.features) && message.features.includes('event_batch');
              this.compactDeltas = this.backend === 'rust' && Array.isArray(message.features) && message.features.includes('delta_pack_v1');
              resolve(this.python);
            } else return fail(typeof message.category === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(message.category) ? message.category : 'handshake_failed');
            continue;
          }
          if (message.type === 'view') {
            const view = this.validate(message);
            if (!view) return fail('bad_view');
            this.requests.delete(view.id);
            if (!this.requests.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
            this.onView(view);
          } else return fail(typeof message.category === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(message.category) ? `worker_${message.category}` : 'unexpected_frame');
        }
      });
      this.write({ type: 'hello', version: PYTHON_CORE_VERSION, locale });
    });
  }
  private validate(m: any): View | undefined {
    if (!Number.isSafeInteger(m.epoch) || !Number.isSafeInteger(m.id) || !this.requests.has(m.id)) return undefined;
    if (typeof m.line !== 'string' || m.line.length > 4096 || !PHASES.has(m.phase) || typeof m.failure !== 'boolean' || typeof m.live !== 'boolean') return undefined;
    if (m.nextWakeAt !== null && !(Number.isFinite(m.nextWakeAt) && m.nextWakeAt > 0)) return undefined;
    return { epoch: m.epoch, id: m.id, line: clean(m.line), phase: m.phase, failure: m.failure, live: m.live, nextWakeAt: m.nextWakeAt ?? undefined };
  }
  /** Watchdog runs only while a view request is outstanding; idle sessions have no timer. */
  private arm() {
    if (this.timer || this.closed) return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => this.checkTimeouts(), WATCHDOG_MS); this.timer.unref?.();
  }
  private checkTimeouts() {
    this.timer = undefined;
    if (this.closed || !this.requests.size) return;
    const now = Date.now(), late = now - this.armedAt > WATCHDOG_MS + 1000;
    // A late check means the host event loop itself was blocked; replies may be queued unread.
    if (!late) for (const sent of this.requests.values()) if (now - sent > REQUEST_TIMEOUT_MS) { this.stopWith('request_timeout'); return; }
    this.arm();
  }
  private stopWith(category: string) { if (this.closed) return; this.stop(); this.onFail(category); }
  write(payload: any) {
    if (this.closed || !this.child) return false;
    if ((this.batchEvents || this.compactDeltas) && payload.type === 'event' && payload.op === 'delta') {
      // Known primitive delta fields only. Six bytes per UTF-16 unit covers
      // JSON escaping; metadata allowance bounds the frame before serializing.
      if (!['epoch', 'seq', 'now'].every(key => Number.isSafeInteger(payload[key]))
        || !Array.isArray(payload.local) || payload.local.length !== 5 || !payload.local.every(Number.isSafeInteger)
        || typeof payload.kind !== 'string' || payload.kind.length > 64 || typeof payload.text !== 'string' || payload.text.length > 301) {
        this.stopWith('bad_delta'); return false;
      }
      if (this.compactDeltas) return this.queuePackedDelta(payload);
      const estimate = 512 + 6 * (payload.kind.length + payload.text.length);
      if (estimate + 128 > MAX_BATCH_BYTES) { this.stopWith('frame_too_large'); return false; }
      if (this.deltas.length && this.deltaBytes + estimate > MAX_BATCH_BYTES) this.flushDeltas();
      if (this.closed) return false;
      if (this.child.stdin.writableLength + this.pendingBytes + this.deltaBytes + estimate > MAX_PENDING_BYTES) { this.stopWith('backpressure'); return false; }
      this.deltas.push({ type: 'event', op: 'delta', epoch: payload.epoch, seq: payload.seq, now: payload.now,
        local: [...payload.local], kind: payload.kind, text: payload.text });
      this.deltaBytes += estimate;
      if (this.deltas.length >= MAX_BATCH_EVENTS) this.flushDeltas();
      else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => { this.batchTimer = undefined; this.flushDeltas(); }, BATCH_DELAY_MS);
        this.batchTimer.unref?.();
      }
      return !this.closed;
    }
    // Critical events and view queries flush every preceding delta first.
    this.flushDeltas();
    return this.queueFrame(payload);
  }
  private queuePackedDelta(p: any): boolean {
    let group = this.deltas.at(-1);
    const same = group && group.epoch === p.epoch && group.kind === p.kind && group.local.every((v: number, i: number) => v === p.local[i]);
    let index = same ? this.packIndex.get(p.text) : undefined;
    let estimate = 60 + (same ? 0 : 512 + 6 * p.kind.length) + (index === undefined ? 6 * p.text.length + 8 : 0);
    if (this.deltas.length && this.deltaBytes + estimate > MAX_BATCH_BYTES) {
      this.flushDeltas(); group = undefined; index = undefined; estimate = 60 + 512 + 6 * (p.kind.length + p.text.length) + 8;
    }
    if (this.closed) return false;
    if (this.child.stdin.writableLength + this.pendingBytes + this.deltaBytes + estimate > MAX_PENDING_BYTES) { this.stopWith('backpressure'); return false; }
    if (!same || !group) {
      group = { epoch: p.epoch, kind: p.kind, local: [...p.local], texts: [], rows: [] };
      this.deltas.push(group); this.packIndex.clear();
    }
    if (index === undefined) { index = group.texts.length; group.texts.push(p.text); this.packIndex.set(p.text, index); }
    group.rows.push([p.seq, p.now, index]); this.deltaCount++; this.deltaBytes += estimate;
    if (this.deltaCount >= MAX_BATCH_EVENTS) this.flushDeltas();
    else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => { this.batchTimer = undefined; this.flushDeltas(); }, BATCH_DELAY_MS);
      this.batchTimer.unref?.();
    }
    return !this.closed;
  }
  private flushDeltas() {
    if (this.batchTimer) clearTimeout(this.batchTimer); this.batchTimer = undefined;
    if (!this.deltas.length || this.closed) return;
    const events = this.deltas, count = this.deltaCount;
    this.deltas = []; this.deltaBytes = 128; this.deltaCount = 0; this.packIndex.clear();
    if (this.compactDeltas) {
      if (count === 1) {
        const g = events[0], [seq, now, index] = g.rows[0];
        this.queueFrame({ type: 'event', op: 'delta', epoch: g.epoch, kind: g.kind, local: g.local, seq, now, text: g.texts[index] });
      } else this.queueFrame({ type: 'delta_pack', groups: events });
    } else this.queueFrame(events.length === 1 ? events[0] : { type: 'event_batch', events });
  }
  private queueFrame(payload: object) {
    if (this.closed || !this.child) return false;
    let line: string;
    try { line = JSON.stringify({ protocol: PROTOCOL, ...payload }); } catch { this.stopWith('serialize_failed'); return false; }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_FRAME) { this.stopWith('frame_too_large'); return false; }
    if (this.child.stdin.writableLength + this.pendingBytes + bytes + 1 > MAX_PENDING_BYTES) { this.stopWith('backpressure'); return false; }
    this.pending += line + '\n'; this.pendingBytes += bytes + 1;
    if (!this.flushQueued) { this.flushQueued = true; queueMicrotask(() => this.flush()); }
    return true;
  }
  private flush() {
    this.flushQueued = false;
    if (this.closed || !this.child || !this.pending) return;
    const data = this.pending; this.pending = ''; this.pendingBytes = 0;
    try { this.child.stdin.write(data); } catch { this.stopWith('pipe_closed'); }
  }
  request(payload: { id: number }) {
    if (this.write({ type: 'view', ...payload })) { this.requests.set(payload.id, Date.now()); this.arm(); }
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    const cancel = this.cancelStart; this.cancelStart = undefined; cancel?.();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.batchTimer) clearTimeout(this.batchTimer); this.batchTimer = undefined;
    this.requests.clear(); this.buffer = ''; this.pending = ''; this.pendingBytes = 0; this.deltas = []; this.deltaBytes = 128; this.deltaCount = 0; this.packIndex.clear();
    const child = this.child; this.child = undefined;
    if (!child) return;
    child.removeAllListeners(); child.stdout?.removeAllListeners(); child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners(); child.stdin?.on('error', () => {});
    try { child.stdin?.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already exited */ }
  }
}

export class RustWorker extends PythonWorker {
  constructor(onView: (view: View) => void, onFail: (category: string) => void) { super(onView, onFail, 'rust'); }
}

/** onChange(paint): 'now' = wake tick (paint immediately), 'soon' = view changed (throttled paint), 'none' = only rescheduling. */
type CoreOptions = { onChange: (paint: 'now' | 'soon' | 'none') => void; onFallback: (category: string) => void; resolve?: () => PythonCommand | undefined; resolveRust?: () => PythonCommand | undefined; script?: string; locale?: () => string; verify?: boolean; paintDeadline?: () => number };

/** Facade with ActivityState's interface. TS always runs; the ready optional worker owns the view. */
export class ActivityCore {
  ts = new ActivityState();
  requested: 'ts' | WorkerKind = 'ts';
  worker: PythonWorker | undefined;
  starting: Promise<void> | undefined;
  failure: string | undefined;
  python = '';
  rust = '';
  epoch = 0;
  private seq = 0;
  private nextId = 1;
  private view: View | undefined;
  private viewQueued = false;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  private dirty: 'none' | 'stream' | 'urgent' = 'none';
  private lastViewAt = 0;
  private forcePaint = false;
  private viewSequence = -1;
  private paintTarget: number | undefined;
  private queries = new Map<number, { epoch: number; seq: number }>();
  /** Per-view TS parity check: diagnostic only, off by default (PITOOLS_CORE_VERIFY=1 or /pitools core verify on). */
  verify = false;
  private expected = new Map<number, string>();
  matches = 0;
  mismatches = 0;
  private keys = new WeakMap<object, string>();
  private keyCounter = 0;
  private seen: Array<{ key: string; startedAt: number }> = [];
  private options: CoreOptions;
  constructor(options: CoreOptions) { this.options = options; this.verify = options.verify ?? process.env.PITOOLS_CORE_VERIFY === '1'; }
  get worker_active() { return !!this.worker && !this.worker.closed && !this.starting; }
  get python_active() { return this.worker_active && this.requested === 'python'; }
  get rust_active() { return this.worker_active && this.requested === 'rust'; }
  get effective(): 'ts' | WorkerKind { return this.worker_active ? this.requested : 'ts'; }
  get config() { return this.ts.config; }
  get lang() { return this.ts.lang; }
  get live() { return this.ts.live; }
  private messageKey(message: object) {
    let key = this.keys.get(message);
    if (!key) { key = `m-${++this.keyCounter}`; this.keys.set(message, key); }
    return key;
  }
  private send(op: string, now: number | undefined, fields: object = {}, urgent = true) {
    if (!this.worker_active) return; // Startup events are covered by the post-ready snapshot.
    const payload: any = { type: 'event', epoch: this.epoch, seq: ++this.seq, op, ...fields };
    if (now !== undefined) { payload.now = now; payload.local = localParts(now); }
    if (urgent && this.paintTarget !== undefined) this.paintTarget = this.seq;
    this.queueView(urgent); // Before write: an immediate view joins this tick's pipe write.
    this.worker!.write(payload);
  }
  /**
   * Every event is still sent, in order; only observation is coalesced. At most one
   * scheduled view is in flight; urgent events ask on the next microtask, streaming
   * deltas at most every VIEW_INTERVAL_MS (the host paints no faster than that).
   */
  private queueView(urgent: boolean) {
    if (!this.worker_active) return;
    if (this.inFlight) { if (urgent || this.dirty === 'none') this.dirty = urgent ? 'urgent' : 'stream'; return; }
    if (this.viewQueued) return;
    const wait = urgent ? 0 : (this.options.paintDeadline?.() ?? this.lastViewAt + VIEW_INTERVAL_MS) - Date.now();
    if (wait <= 0) {
      if (this.viewTimer) { clearTimeout(this.viewTimer); this.viewTimer = undefined; }
      this.viewQueued = true;
      queueMicrotask(() => { this.viewQueued = false; this.scheduledView(); });
    } else if (!this.viewTimer) {
      this.viewTimer = setTimeout(() => { this.viewTimer = undefined; this.scheduledView(); }, wait);
      this.viewTimer.unref?.();
    }
  }
  private scheduledView() {
    if (this.inFlight || !this.worker_active) return;
    const now = Date.now();
    this.lastViewAt = now;
    this.inFlight = this.requestView(now) || 0;
  }
  private clearSchedule() {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = undefined; this.inFlight = 0; this.dirty = 'none'; this.forcePaint = false;
    this.viewSequence = -1; this.paintTarget = undefined; this.queries.clear();
  }
  /** Ask the worker for the view at `now`; returns the request id. With verify, the TS expectation is taken at the same queue point. */
  requestView(now: number): number | false {
    if (!this.worker_active) return false;
    const id = this.nextId++;
    if (this.verify) {
      this.expected.set(id, JSON.stringify([this.ts.line(now), this.ts.phase, this.ts.failure, this.ts.live, this.ts.nextWakeAt(now) ?? null]));
      if (this.expected.size > 256) this.expected.delete(this.expected.keys().next().value!);
    }
    this.queries.set(id, { epoch: this.epoch, seq: this.seq });
    if (this.queries.size > 256) this.queries.delete(this.queries.keys().next().value!);
    this.worker!.request({ id, epoch: this.epoch, now } as any);
    return id;
  }
  private accept(view: View) {
    const query = this.queries.get(view.id); this.queries.delete(view.id);
    let followup: 'none' | 'stream' | 'urgent' = 'none';
    if (this.inFlight && view.id >= this.inFlight) {
      this.inFlight = 0;
      followup = this.dirty; this.dirty = 'none';
    }
    if (view.epoch !== this.epoch || (this.view && this.view.epoch === view.epoch && view.id < this.view.id)) {
      if (followup !== 'none') this.queueView(followup === 'urgent');
      return;
    }
    const expected = this.expected.get(view.id); this.expected.delete(view.id);
    if (expected !== undefined) expected === JSON.stringify([view.line, view.phase, view.failure, view.live, view.nextWakeAt ?? null]) ? this.matches++ : this.mismatches++;
    const old = this.view;
    this.view = view;
    this.viewSequence = query?.epoch === view.epoch ? query.seq : -1;
    const changed = !old || old.epoch !== view.epoch || old.line !== view.line || old.phase !== view.phase || old.failure !== view.failure;
    // Wake ticks paint at once (like TS) so frames stay on cadence; event-driven changes use the throttle.
    const tick = this.forcePaint;
    this.forcePaint = false;
    this.options.onChange(tick ? 'now' : changed ? 'soon' : 'none');
    // A paint may advance the shared deadline. Observe it before scheduling the
    // stream followup, rather than eagerly creating a second query for this frame.
    if (followup !== 'none') this.queueView(followup === 'urgent');
  }
  private fail(category: string) {
    this.worker?.stop(); this.worker = undefined; this.view = undefined; this.expected.clear(); this.clearSchedule();
    this.failure = category;
    this.options.onFallback(category);
  }
  private snapshot() {
    const state: any = this.ts.snapshot();
    state.startedLocal = localParts(state.startedAt);
    state.seenMessageKeys = this.seen.filter(item => item.startedAt === this.ts.startedAt).map(item => item.key);
    return state;
  }
  usePython(): Promise<string | undefined> { return this.useCore('python'); }
  useRust(): Promise<string | undefined> { return this.useCore('rust'); }
  private async useCore(kind: WorkerKind): Promise<string | undefined> {
    if (this.requested === kind && this.worker_active) return undefined;
    if (this.requested === kind && this.starting) { await this.starting; return this.effective === kind ? undefined : this.failure ?? 'stopped'; }
    this.dispose(); this.requested = kind;
    this.failure = undefined;
    const command = kind === 'python' ? (this.options.resolve ?? resolvePython)() : (this.options.resolveRust ?? resolveRust)();
    if (!command) { this.failure = `${kind}_not_found`; return this.failure; }
    const Worker = kind === 'python' ? PythonWorker : RustWorker;
    const worker = new Worker(view => { if (this.worker === worker) this.accept(view); }, category => { if (this.worker === worker) this.fail(category); });
    this.worker = worker;
    const starting = worker.start(command, (this.options.locale ?? (() => Intl.DateTimeFormat().resolvedOptions().locale))(), this.options.script).then(version => {
      if (this.worker === worker) { if (kind === 'python') this.python = version; else this.rust = version; }
    }, error => {
      if (this.worker === worker) { this.worker = undefined; this.failure = String(error?.message ?? error).slice(0, 40); }
    });
    this.starting = starting;
    await starting;
    if (this.starting === starting) this.starting = undefined;
    if (this.worker !== worker || worker.closed) return this.failure ?? 'stopped';
    // Adopt TS state at this exact point, so a mid-task switch never fakes idle or progress.
    this.epoch++; this.seq = 0; this.view = undefined;
    this.send('snapshot', undefined, { state: this.snapshot() });
    return undefined;
  }
  useTs() {
    this.requested = 'ts';
    this.starting = undefined;
    this.worker?.stop(); this.worker = undefined; this.view = undefined; this.expected.clear(); this.clearSchedule();
  }
  dispose() { this.worker?.stop(); this.worker = undefined; this.view = undefined; this.expected.clear(); this.clearSchedule(); this.starting = undefined; }
  // ---- ActivityState interface ----
  configure(config: any) { this.ts.configure(config); this.send('configure', undefined, { config: this.ts.config }); }
  reset(config?: any) {
    this.ts.reset(config); this.seen = [];
    this.epoch++; this.seq = 0; this.view = undefined; this.expected.clear(); this.clearSchedule();
    this.send('reset', undefined, { config: this.ts.config });
  }
  begin(now: number) { this.seen = []; this.ts.begin(now); this.send('begin', now); }
  turnStart(now: number) { if (!this.ts.live) this.seen = []; this.ts.turnStart(now); this.send('turnStart', now); }
  streamStart(now: number) { if (!this.ts.live) this.seen = []; this.ts.streamStart(now); this.send('streamStart', now); }
  delta(type: string, text: string, now: number) { if (!this.ts.live) this.seen = []; this.ts.delta(type, text, now); this.send('delta', now, { kind: String(type).slice(0, 64), text: tail(text) }, false); }
  messageEnd(message: any, now: number) {
    if (!this.ts.live) this.seen = [];
    const text = visibleTextTail(message?.content);
    this.ts.messageEnd(message, now, text);
    const key = this.messageKey(message);
    if (!this.seen.some(item => item.key === key && item.startedAt === this.ts.startedAt)) this.seen.push({ key, startedAt: this.ts.startedAt });
    const tokens = message?.usage?.output;
    this.send('messageEnd', now, { text, messageKey: key, outputTokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null });
  }
  toolStart(id: string, name: any, args: any, now: number) {
    if (!this.ts.live) this.seen = [];
    this.ts.toolStart(id, name, args, now);
    const raw = args?.command ?? args?.path ?? args?.file_path ?? args?.filePath ?? args?.query ?? args?.url;
    const toolName = String(name ?? '');
    if (this.worker_active && (String(id).length > MAX_TEXT || toolName.length > MAX_TEXT || typeof raw === 'string' && raw.length > MAX_TEXT)) { this.fail('text_too_large'); return; }
    this.send('toolStart', now, { id: String(id), name: toolName, detail: typeof raw === 'string' ? raw : null });
  }
  toolEnd(id: string, error: any, now: number) {
    this.ts.toolEnd(id, error, now);
    if (this.worker_active && String(id).length > MAX_TEXT) { this.fail('text_too_large'); return; }
    this.send('toolEnd', now, { id: String(id), error: !!error });
  }
  finish(now: number, reason = '') { this.ts.finish(now, reason); this.send('finish', now, { reason: String(reason ?? '').slice(0, 64) }); }
  // ---- view ----
  private current() { return this.worker_active && this.view && this.view.epoch === this.epoch ? this.view : undefined; }
  line(now: number) {
    if (!this.worker_active) return this.ts.line(now);
    return this.current()?.line ?? (this.ts.config.enabled ? `⏳ ${this.requested === 'rust' ? 'Rust' : 'Python'} 核心准备中…` : '');
  }
  get phase() { return this.worker_active ? this.current()?.phase ?? 'waiting' : this.ts.phase; }
  get failed() { return this.worker_active ? this.current()?.failure ?? false : this.ts.failure; }
  nextWakeAt(now: number) {
    if (!this.worker_active) return this.ts.nextWakeAt(now);
    const wake = this.current()?.nextWakeAt;
    // A past wake from a stale view: when a fresh view is already coming, its reply reschedules.
    if (wake !== undefined && wake <= now && (this.inFlight || this.viewQueued || this.viewTimer)) return undefined;
    return wake;
  }
  /** A paint never waits another throttle interval for a view already in flight. */
  get readyForPaint() { return !this.worker_active || !!this.current() && this.viewSequence >= (this.paintTarget ?? this.seq); }
  requestPaintView() {
    if (!this.worker_active) return;
    // Freeze this paint's input frontier. Later deltas belong to a later frame;
    // chasing them continuously could starve animation on a fast live stream.
    this.paintTarget ??= this.seq;
    this.forcePaint = true;
    const query = this.queries.get(this.inFlight);
    if (query?.epoch === this.epoch && query.seq >= this.paintTarget) return;
    this.queueView(true);
  }
  completePaint() { this.paintTarget = undefined; }
  /** Wake tick: TS paints now; a worker paints when the fresh view arrives (even unchanged, for trace clocks). */
  tick() {
    if (!this.worker_active) return this.options.onChange('now');
    this.requestPaintView();
  }
  status() {
    const name = this.requested === 'rust' ? 'Rust' : this.requested === 'python' ? 'Python' : 'TS';
    const actual = this.worker_active ? `${name} ${this.requested === 'rust' ? this.rust : this.python}（worker pid ${this.worker?.child?.pid ?? '?'}）` : this.starting ? `${name} 启动中` : 'TS';
    return `请求 ${name} · 实际 ${actual}${this.failure ? ` · 最近故障 ${this.failure}` : ''}${this.verify ? ` · TS 对照一致 ${this.matches} / 不一致 ${this.mismatches}` : ' · TS 对照关闭'}`;
  }
}
