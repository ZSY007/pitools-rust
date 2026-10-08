// Local, pure activity state. No filesystem, network, process, or Pi UI access.
// Data and mixSlot are derived from dsh-working-activity 0.5.1 (BSD-3-Clause).
// Copyright (c) 2026, chimney (ccch1mneyyy); see data/activity/LICENSE.
import { safeText, visibleTextTail } from './core.ts';
import { PHRASES, FRAME_DATA, ACTIVITY_DATA_VERSION } from './data/activity/data.ts';
export const ACTIVITY_VERSION = '0.1.13';
export { ACTIVITY_DATA_VERSION };
// Project-owned preset, kept separate from the verbatim upstream data.
export const PI_PRESET = { frames: ['π ·  ', 'π ·· ', 'π ···'], intervalMs: 240, restFrame: 'π    ' };
export const ACTIVITY_PRESETS = { ...FRAME_DATA.presets, pi: PI_PRESET };
const RANDOM_FRAME_NAMES = Object.keys(FRAME_DATA.presets); // Keep legacy random slots/order unchanged.
export const FRAME_NAMES = Object.keys(ACTIVITY_PRESETS);
export const DEFAULT_ACTIVITY = { enabled: true, frames: 'pi', lang: 'zh', narrate: true, contract: true, phrases: true };
export function normalizeActivity(value: any = {}) {
  const out = { ...DEFAULT_ACTIVITY };
  if (!value || typeof value !== 'object') return out;
  for (const key of ['enabled', 'narrate', 'contract', 'phrases']) if (typeof value[key] === 'boolean') out[key] = value[key];
  if (value.frames === 'random' || Object.hasOwn(ACTIVITY_PRESETS, value.frames)) out.frames = value.frames;
  if (['zh', 'en', 'auto'].includes(value.lang)) out.lang = value.lang;
  return out;
}
export function restoreActivityConfig(entries: any[]) {
  let config = normalizeActivity();
  for (const entry of Array.isArray(entries) ? entries : []) if (entry?.type === 'custom' && entry.customType === 'pitools-activity-config' && entry.data?.schema === 1) config = normalizeActivity(entry.data.config);
  return config;
}
// Upstream's deterministic 32-bit avalanche; never randomize while rendering.
export function mixSlot(seed: number, slot: number) {
  let h = (Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(slot | 0, 0x85EBCA6B)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545F491) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x9E3779B1) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
export function pick(entries: string[], seed: number, slot = 0) {
  return entries?.length ? entries[mixSlot(seed, slot) % entries.length] : '';
}
export function activityDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
}
function fragment(value: any) {
  // Remove the COMPLETE escape sequence, not just ESC, before whitespace cleanup.
  return safeText(String(value ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).replace(/\s+/g, ' ').trim();
}
function cutColumns(text: string, budget: number) {
  let result = '', columns = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    const width = /\p{Mark}/u.test(char) || point === 0x200d ? 0 : point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6 || point >= 0x1f000 && point <= 0x1faff || point >= 0x20000) ? 2 : 1;
    if (columns + width > budget) break;
    result += char; columns += width;
  }
  return result;
}
export function extractNarration(visibleText: string) {
  const text = String(visibleText ?? '');
  const start = Math.max(0, text.length - 300), tail = text.slice(start);
  const re = /(?:^|\n)⏵[ \t]*([^\n⏵]*)/g;
  let candidate: string | undefined;
  for (const match of tail.matchAll(re)) {
    // Slicing the rolling buffer must not turn a mid-line marker into line-start.
    if (match.index === 0 && start > 0 && text[start - 1] !== '\n') continue;
    candidate = match[1];
  }
  if (candidate === undefined) return undefined;
  let clean = fragment(candidate);
  const boundary = /[。．!?！？;；]|\.(?=\s|$|[A-Z][a-z])/.exec(clean);
  if (boundary) clean = clean.slice(0, boundary.index + 1);
  clean = cutColumns(clean, 80).replace(/[。．.!！,，、;；]+$/g, '').trim();
  return clean || undefined;
}
export function narrationContract(lang: string) {
  return PHRASES.uiStrings[lang === 'en' ? 'en' : 'zh']['narrate-instruction'];
}
// Deliberately separate ordered regex tables for zh/en; do not use ByName.
const actionTables = Object.fromEntries(['zh', 'en'].map(lang => [lang, PHRASES.toolAction[lang].map(row => ({ re: new RegExp(row.match.pattern, row.match.flags), actions: row.actions }))]));
export function toolAction(name: string, lang: string, seed: number, slot: number) {
  const plain = fragment(name).replace(/^(?:functions|tools)\./, '');
  const row = actionTables[lang === 'en' ? 'en' : 'zh'].find(item => item.re.test(plain));
  return pick(row?.actions ?? PHRASES.toolFallback[lang === 'en' ? 'en' : 'zh'], seed, slot);
}
function toolDetail(args: any) {
  const raw = args?.command ?? args?.path ?? args?.file_path ?? args?.filePath ?? args?.query ?? args?.url;
  return typeof raw === 'string' ? cutColumns(fragment(raw), 40) : '';
}
export class ActivityState {
  config: any;
  phase = 'idle';
  startedAt = 0;
  phaseAt = 0;
  thinkingPhases = 0;
  active = new Map<string, any>();
  completed = 0;
  firstToolAt: number | undefined;
  lastTool: any;
  narration = '';
  lastNarration = '';
  lastChunkAt: number | undefined;
  doneText = '';
  presetName = 'pi';
  endAt: number | undefined;
  failure = false;
  outputTokens = 0;
  seenMessages = new WeakSet<object>();
  constructor(config = DEFAULT_ACTIVITY) { this.configure(config); }
  configure(config: any) {
    this.config = normalizeActivity(config);
    this.presetName = this.config.frames === 'random' ? RANDOM_FRAME_NAMES[mixSlot(this.startedAt, 123) % RANDOM_FRAME_NAMES.length] : this.config.frames;
  }
  reset(config = this.config) {
    this.phase = 'idle'; this.startedAt = 0; this.phaseAt = 0; this.thinkingPhases = 0;
    this.active.clear(); this.completed = 0; this.firstToolAt = undefined; this.lastTool = undefined;
    this.narration = ''; this.lastNarration = ''; this.lastChunkAt = undefined; this.doneText = ''; this.endAt = undefined;
    this.failure = false; this.outputTokens = 0; this.seenMessages = new WeakSet(); this.configure(config);
  }
  get live() { return this.phase !== 'idle' && this.phase !== 'done'; }
  get lang() {
    if (this.config.lang !== 'auto') return this.config.lang;
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('en') ? 'en' : 'zh';
  }
  setPhase(phase: string, now: number) {
    if (phase === this.phase) return;
    if (phase === 'thinking') this.thinkingPhases++;
    this.phase = phase; this.phaseAt = now;
  }
  begin(now: number) { this.reset(); this.startedAt = now; this.setPhase('waiting', now); this.configure(this.config); }
  turnStart(now: number) {
    if (!this.live) this.begin(now);
    else if (!this.active.size) this.streamStart(now);
  }
  streamStart(now: number) {
    if (!this.live) this.begin(now);
    this.narration = ''; this.lastChunkAt = undefined;
    if (!this.active.size) this.setPhase('waiting', now);
  }
  delta(type: string, visibleText: string, now: number) {
    if (!this.live) this.begin(now);
    if (!this.active.size) this.setPhase('thinking', now);
    this.lastChunkAt = now;
    if (!this.config.narrate || !type.startsWith('text')) return;
    const narration = extractNarration(visibleText);
    if (narration) this.narration = this.lastNarration = narration;
  }
  messageEnd(message: any, now: number, text = visibleTextTail(message.content)) {
    if (!this.live) this.begin(now);
    if (!this.active.size) this.setPhase('thinking', now);
    const narration = this.config.narrate ? extractNarration(text) : undefined;
    if (narration) { this.narration = this.lastNarration = narration; this.lastChunkAt = now; }
    if (!this.seenMessages.has(message)) {
      this.seenMessages.add(message);
      const tokens = message.usage?.output;
      if (Number.isFinite(tokens) && tokens >= 0) this.outputTokens += tokens;
    }
  }
  toolStart(id: string, name: string, args: any, now: number) {
    if (!this.live) this.begin(now);
    if (this.active.has(id)) return;
    this.firstToolAt ??= now;
    this.active.set(id, { id, name: fragment(name), action: toolAction(name, this.lang, this.startedAt, this.completed + this.active.size), detail: toolDetail(args), startedAt: now });
    this.setPhase('tool', now);
  }
  toolEnd(id: string, error: boolean, now: number) {
    const tool = this.active.get(id);
    if (!tool) return;
    this.lastTool = { ...tool, endedAt: now, error }; this.failure = !!error;
    this.completed++; this.active.delete(id);
    if (!this.active.size) this.setPhase('thinking', now);
  }
  finish(now: number, reason = '') {
    if (this.phase === 'idle' || this.phase === 'done') return;
    this.endAt = now;
    const lang = this.lang;
    const prefix = reason === 'aborted' ? lang === 'zh' ? '已中断' : 'Interrupted' : reason === 'error' ? lang === 'zh' ? '请求失败' : 'Request failed' : this.config.phrases ? pick((this.failure ? PHRASES.fail : PHRASES.done)[lang], this.startedAt, 11) : PHRASES.uiStrings[lang]['done-prefix'];
    this.failure ||= reason === 'error';
    this.doneText = `${prefix} · ${this.completed} ${lang === 'zh' ? '工具' : 'tools'} · ${lang === 'zh' ? '总' : 'total '}${activityDuration(now - this.startedAt)}${this.outputTokens ? ` · ↓ ${this.outputTokens >= 1000 ? (this.outputTokens / 1000).toFixed(1) + 'k' : this.outputTokens} tokens` : ''}`;
    this.active.clear(); this.setPhase('done', now);
  }
  phrase(now: number) {
    const lang = this.lang;
    if (!this.config.phrases) return PHRASES.uiStrings[lang][this.phase === 'waiting' ? 'waiting-label' : 'thinking-label'];
    const rare = this.phase === 'thinking' && this.thinkingPhases === 1 && mixSlot(this.startedAt, 0x5EED) % 150 === 0;
    const rotate = rare ? 7500 : 4000, slot = Math.max(0, Math.floor((now - this.phaseAt) / rotate));
    if (this.phase === 'waiting') return pick(PHRASES.waiting[lang], this.startedAt, slot);
    if (this.thinkingPhases === 1 && slot === 0) {
      const date = new Date(this.startedAt), mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const holiday = PHRASES.lunarNewYearDays[`${date.getFullYear()}-${mmdd}`] ? PHRASES.lunarNewYear[lang] : PHRASES.holiday[lang][mmdd];
      if (holiday) return pick(holiday, this.startedAt, slot);
      if (rare) return pick(PHRASES.rare[lang], this.startedAt, slot);
      if ([0, 6].includes(date.getDay())) return pick(PHRASES.weekend[lang], this.startedAt, slot);
    }
    if (rare) return pick(PHRASES.rare[lang], this.startedAt, slot);
    const elapsed = this.phaseAt + slot * rotate - this.startedAt;
    const tiers = PHRASES.thinkingTiers[lang];
    const tier = [...tiers].reverse().find(row => elapsed >= row.atMs)?.pool;
    const night = new Date(this.startedAt).getHours() < 6;
    return pick(tier ?? [...PHRASES.thinking[lang], ...(night ? PHRASES.thinkingNight[lang] : [])], this.startedAt, slot);
  }
  frame(now: number) {
    const preset = ACTIVITY_PRESETS[this.presetName];
    if (!this.live && this.presetName === 'pi') return PI_PRESET.restFrame;
    return preset.frames[Math.floor(Math.max(0, now - this.startedAt) / preset.intervalMs) % preset.frames.length] ?? '';
  }
  line(now: number) {
    if (!this.config.enabled) return '';
    if (this.phase === 'idle') {
      const frame = this.presetName === 'pi' ? PI_PRESET.restFrame : ACTIVITY_PRESETS[this.presetName].frames[0] ?? '';
      return `${frame} ⏵ ${this.lang === 'zh' ? '待机中 · 等待任务' : 'Idle · ready for a task'}`.trim();
    }
    if (this.phase === 'done') return `${this.frame(this.endAt ?? this.startedAt)} ⏵ ${this.config.narrate && this.lastNarration ? this.lastNarration + ' · ' : ''}${this.doneText}`.trim();
    const frame = this.frame(now);
    const narration = this.config.narrate && this.narration && this.lastChunkAt !== undefined && now - this.lastChunkAt <= 5000 ? `⏵ ${this.narration}` : '';
    let text;
    if (this.active.size) {
      const tool = [...this.active.values()].at(-1);
      const opening = this.config.phrases && this.firstToolAt !== undefined && now - this.firstToolAt < 2500 ? pick(PHRASES.toolOpening[this.lang], this.startedAt, 0) + ' · ' : '';
      text = `${narration ? narration + ' · ' : ''}${opening}${tool.action} ${tool.detail || tool.name} · ${activityDuration(now - tool.startedAt)}${this.active.size > 1 ? ` · ${this.active.size} ${this.lang === 'zh' ? '并行' : 'parallel'}` : ''}`;
    } else if (this.config.phrases && this.lastTool && now - this.lastTool.endedAt < 2500) {
      const ms = this.lastTool.endedAt - this.lastTool.startedAt;
      text = `✓ ${this.lastTool.action} ${this.lastTool.detail || this.lastTool.name} · ${ms < 1000 ? `${Math.floor(ms)}ms` : activityDuration(ms)}`;
    } else text = `${narration || this.phrase(now)} · ${this.lang === 'zh' ? '总' : 'total '}${activityDuration(now - this.startedAt)}`;
    return `${frame} ${text}`.trim();
  }
  /** Plain JSON state for external activity cores; message identity is supplied by the host. */
  snapshot() {
    return { config: { ...this.config }, phase: this.phase, startedAt: this.startedAt, phaseAt: this.phaseAt, thinkingPhases: this.thinkingPhases,
      active: [...this.active.values()].map(tool => ({ ...tool })), completed: this.completed, firstToolAt: this.firstToolAt ?? null,
      lastTool: this.lastTool ? { ...this.lastTool, error: !!this.lastTool.error } : null, narration: this.narration, lastNarration: this.lastNarration,
      lastChunkAt: this.lastChunkAt ?? null, doneText: this.doneText, presetName: this.presetName, endAt: this.endAt ?? null, failure: this.failure, outputTokens: this.outputTokens };
  }
  nextWakeAt(now: number) {
    if (!this.config.enabled || !this.live) return undefined;
    const preset = ACTIVITY_PRESETS[this.presetName];
    const next = (anchor: number, interval: number) => anchor + (Math.floor(Math.max(0, now - anchor) / interval) + 1) * interval;
    const tool = [...this.active.values()].at(-1);
    const rare = this.phase === 'thinking' && this.thinkingPhases === 1 && mixSlot(this.startedAt, 0x5EED) % 150 === 0;
    const candidates = [next(tool?.startedAt ?? this.startedAt, 1000), next(this.phaseAt, rare ? 7500 : 4000)];
    if (preset.frames.length > 1) candidates.push(next(this.startedAt, Math.max(16, preset.intervalMs)));
    if (this.lastChunkAt !== undefined && this.narration) candidates.push(this.lastChunkAt + 5001);
    if (this.lastTool) candidates.push(this.lastTool.endedAt + 2500);
    if (this.firstToolAt !== undefined) candidates.push(this.firstToolAt + 2500);
    return Math.min(...candidates.filter(at => at > now));
  }
}
