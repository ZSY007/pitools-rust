import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey, parseColor, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { TraceStore, DetailCache, BlockTextCache, visibleTextTail, safeText, json, summary, duration, contentText, emptyThinking, missingThinkingCount, validTimestamp, validModelTiming, timingInfo, CORE_VERSION } from './core.ts';
import { renderDetail, detailThemeKey, RENDERER_VERSION } from './rendering.ts';

import { ActivityState, normalizeActivity, restoreActivityConfig, narrationContract, FRAME_NAMES, ACTIVITY_VERSION, ACTIVITY_DATA_VERSION } from './activity.ts';
import { ActivityCore, PYTHON_CORE_VERSION, RUST_CORE_VERSION } from './python-core.ts';

const VERSION = '0.1.13';

export default function pitools(pi: ExtensionAPI, options: { edition?: 'development' | 'ts' | 'python' | 'rust' } = {}) {
  const edition = options.edition ?? 'development';
  if (!['development', 'ts', 'python', 'rust'].includes(edition)) throw new Error('pitools 包类型无效。');
  // Shared host event bus, not a process-global singleton: Pi invalidates these
  // subscriptions on reload. Reject a second edition before registering any UI.
  const claim: { owner?: string } = {};
  pi.events.emit('pitools:edition-owner', claim);
  if (claim.owner) throw new Error(`pitools 已加载 ${claim.owner} 版；TS/Python/Rust 三包只选一个，请移除旧包后 /reload。`);
  // Fail once at load time, before any stream handlers/timers are registered,
  // rather than flooding every message with missing-function exceptions.
  const required = { TraceStore, DetailCache, BlockTextCache, visibleTextTail, safeText, json, summary, duration, contentText, emptyThinking, missingThinkingCount, validTimestamp, validModelTiming, timingInfo, renderDetail, detailThemeKey, ActivityState, ActivityCore, normalizeActivity, restoreActivityConfig, narrationContract };
  const missing = Object.entries(required).filter(([, value]) => typeof value !== 'function').map(([name]) => name);
  if (missing.length || CORE_VERSION !== VERSION || RENDERER_VERSION !== VERSION || ACTIVITY_VERSION !== VERSION || ACTIVITY_DATA_VERSION !== VERSION || PYTHON_CORE_VERSION !== VERSION || RUST_CORE_VERSION !== VERSION) {
    throw new Error(`pitools 模块版本不一致：入口 ${VERSION}，核心 ${CORE_VERSION ?? '未知'}，渲染 ${RENDERER_VERSION ?? '未知'}，活动 ${ACTIVITY_VERSION ?? '未知'}，数据 ${ACTIVITY_DATA_VERSION ?? '未知'}，Python 适配 ${PYTHON_CORE_VERSION ?? '未知'}，Rust 适配 ${RUST_CORE_VERSION ?? '未知'}${missing.length ? `；缺少 ${missing.join(', ')}` : ''}。请替换完整插件目录后 /reload，必要时重启 Pi。`);
  }
  const store = new TraceStore();
  let notifyCtx: ExtensionContext | undefined;
  // TS core is the default and always-running fallback; Python is opt-in (/pitools core python or PITOOLS_CORE=python).
  const activity = new ActivityCore({
    paintDeadline: () => lastPaint + 120,
    // External view replies: wake ticks paint at once (like TS); other changes use the 120ms throttle; unchanged views do not repaint.
    onChange: mode => { if (mode === 'now') { if (tuiActive && enabled) paint(); scheduleWake(); } else if (mode === 'soon') refresh(false); else scheduleWake(); },
    onFallback: category => {
      try { notifyCtx?.ui.notify(`pitools ${activity.requested === 'rust' ? 'Rust' : 'Python'} 核心已停止（${category}），已回退 TS 核心；不会自动重启。/pitools core ${activity.requested} 可重试。`, 'warning'); } catch { /* UI may be closing. */ }
      refresh();
    },
  });
  if (typeof activity.requestPaintView !== 'function' || typeof activity.completePaint !== 'function' || typeof activity.readyForPaint !== 'boolean') throw new Error('pitools 活动适配器不完整，请替换完整目录后重载。');
  let coreAtStart: 'python' | 'rust' | undefined = edition === 'python' || edition === 'rust' ? edition : edition === 'development' && process.env.PITOOLS_CORE === 'rust' ? 'rust' : edition === 'development' && process.env.PITOOLS_CORE === 'python' ? 'python' : undefined;
  if (typeof store.remove !== 'function' || typeof store.touch !== 'function') throw new Error('pitools 核心模块不完整，请替换完整目录后重载。');
  let enabled = true;
  let selected = -1;
  let selectedRecord: any;
  let follow = true;
  let repaint: (() => void) | undefined;
  let inspectorRepaint: (() => void) | undefined;
  let closeInspector: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let tuiActive = false;
  let lastPaint = 0;
  let streaming = new Map<number, any>();
  const blockText = new BlockTextCache();
  const missingThinkingByCall = new Map<string, number>();
  const pendingModelTimings = new Map<object, any>();
  function persistModelTiming(message: object, messageEntryId: string) {
    const timing = pendingModelTimings.get(message);
    if (!timing || !messageEntryId) return;
    if (!validModelTiming(timing)) { pendingModelTimings.delete(message); return; }
    pi.appendEntry('pitools-model-timing', { schema: 1, messageEntryId, ...timing });
    pendingModelTimings.delete(message);
    for (const r of store.records) if (r.kind === 'model' && r.modelMessage === message) { r.messageEntryId = messageEntryId; delete r.modelMessage; store.touch(r); }
  }
  let requestStart: number | undefined;
  let firstToken: number | undefined;
  // theme.style treats strings as theme tokens; custom colors must be Color objects.
  const palette = { input: parseColor('#7aa2f7'), model: parseColor('#b58bd5'), tool: parseColor('#e9a04b'), error: parseColor('#ef6b73') };
  const color = (theme: Theme, kind: string, text: string) => theme.style(text, { fg: palette[kind as keyof typeof palette] ?? palette.model });
  const status = (r: any) => r.live ? '运行中' : r.error ? '失败' : r.aborted ? '已中断' : r.incomplete ? '已中断（未收到完整结束事件）' : r.kind === 'tool' && !r.result ? '结果未记录' : '已完成';
  const outputPreview = (r: any) => r.result ? (contentText(r.result.content ?? []).replace(/\n/g, ' ') || json(r.result).replace(/\n/g, ' ')).slice(0, 512) : r.live ? '执行中…' : '结果未记录';
  function guarded(ctx: ExtensionContext, label: string, render: (width: number) => string[]) {
    let reported = false;
    return (width: number): string[] => {
      if (!Number.isFinite(width) || width < 1) return [];
      try { return render(Math.floor(width)); }
      catch (error) {
        if (!reported) {
          reported = true;
          try { ctx.ui.notify(`pitools ${label}渲染失败，已隔离：${safeText(error instanceof Error ? error.message : error)}`, 'warning'); } catch { /* UI may already be closing. */ }
        }
        return [truncateToWidth(`pitools ${label}暂不可用；Esc 返回或 /pitools off`, width)];
      }
    };
  }
  function toolSchema(name: string) {
    try { const tool = pi.getAllTools().find(t => t.name === name); return tool ? { description: tool.description, parameters: tool.parameters } : undefined; }
    catch { return undefined; }
  }
  const isTui = (ctx: ExtensionContext) => ctx.mode === 'tui';
  const paint = () => {
    if (paintTimer) clearTimeout(paintTimer); paintTimer = undefined;
    // The trace is complete locally; wait only for the corresponding activity view,
    // not another paint interval. A failed worker immediately renders its TS mirror.
    if (!activity.readyForPaint) { activity.requestPaintView(); return; }
    activity.completePaint();
    lastPaint = Date.now(); repaint?.(); inspectorRepaint?.();
  };
  function scheduleWake() {
    if (timer) clearTimeout(timer); timer = undefined;
    if (!tuiActive || !enabled) return;
    const now = Date.now();
    const wake = activity.nextWakeAt(now);
    const traceWake = store.records.some((r: any) => r.live) ? now + 500 : undefined;
    const next = Math.min(wake ?? Infinity, traceWake ?? Infinity);
    if (!Number.isFinite(next)) return; // No idle/done animation clock.
    // TS paints now; external cores paint when their fresh view arrives.
    timer = setTimeout(() => {
      timer = undefined;
      if (activity.effective !== 'ts') activity.tick(); else { paint(); scheduleWake(); }
    }, Math.max(1, next - now));
    timer.unref?.();
  }
  const refresh = (immediate = true) => {
    if (follow) selected = store.records.length - 1;
    else if (selectedRecord && store.records.includes(selectedRecord)) selected = store.records.indexOf(selectedRecord);
    else selected = Math.max(0, Math.min(selected, store.records.length - 1));
    selectedRecord = store.records[selected];
    scheduleWake();
    if (!tuiActive || !enabled) { if (paintTimer) clearTimeout(paintTimer); paintTimer = undefined; return; }
    if (immediate || Date.now() - lastPaint >= 120) {
      if (paintTimer) clearTimeout(paintTimer); paintTimer = undefined; paint();
    } else if (!paintTimer) {
      paintTimer = setTimeout(() => { paintTimer = undefined; if (tuiActive && enabled) paint(); }, Math.max(1, lastPaint + 120 - Date.now()));
      paintTimer.unref?.();
    }
  };
  function titleLine(theme: Theme, width: number, title: string, compact: string) {
    const text = activity.line(Date.now());
    if (!text) return theme.fg('accent', truncateToWidth(title, width));
    const marker = activity.failed ? theme.fg('error', '●')
      : activity.phase === 'done' ? theme.fg('success', '●')
      : color(theme, 'input', '●'); // Idle/running blue, matching the input lane.
    if (width < 3) return marker;
    const lineWidth = width - 2; // One column for the dot, one for its space.
    const separator = '  │  ';
    const gap = visibleWidth(separator);
    const activityWidth = Math.min(visibleWidth(text), 90);
    const statistics = activityWidth + gap + visibleWidth(title) <= lineWidth ? title : compact;
    const available = lineWidth - visibleWidth(statistics) - gap;
    // The activity owns the left edge, including on narrow terminals. Hide
    // statistics before sacrificing the activity; never add a second line.
    const line = available < 12
      ? truncateToWidth(text, lineWidth)
      : truncateToWidth(text, Math.min(available, 90)) + separator + statistics;
    // Only the dot changes color. All words, timing, and statistics stay accent.
    // Emoji retain their terminal-native color. Event lanes keep their palette.
    return marker + ' ' + theme.fg('accent', line);
  }
  const choose = (delta: number) => {
    follow = false;
    selected = Math.max(0, Math.min(store.records.length - 1, selected + delta));
    selectedRecord = store.records[selected];
    refresh();
  };
  function widget(ctx: ExtensionContext) {
    if (!isTui(ctx)) return;
    if (!enabled) { ctx.ui.setWidget('pitools', undefined); repaint = undefined; return; }
    ctx.ui.setWidget('pitools', (tui, theme) => {
      repaint = () => tui.requestRender();
      return {
        invalidate() {},
        render: guarded(ctx, '轨迹', (width) => {
          const clip = (s: string) => truncateToWidth(s, Math.max(1, width));
          const cap = Math.max(1, Math.floor((width - 8) / 2));
          const left = Math.max(0, Math.min(selected - Math.floor(cap / 2), store.records.length - cap));
          const window = store.records.slice(left, left + cap);
          const lane = (kind: string, label: string) => clip(label + window.map((r: any, n: number) => {
            const cell = r.kind === kind ? (left + n === selected ? '▣ ' : r.live ? '░ ' : '█ ') : '· ';
            return color(theme, r.error ? 'error' : kind, cell);
          }).join(''));
          const r = store.records[selected];
          return [
            titleLine(theme, width, `pitools · 第 ${r?.turn ?? store.turn} 轮 · ${store.records.length} 个事件${store.hiddenThinking ? ` · 已收起 ${store.hiddenThinking} 个空思考` : ''}${store.dropped ? `（较早 ${store.dropped} 个已移出内存）` : ''}`, `pitools · ${r?.turn ?? store.turn}轮 · ${store.records.length}事件`),
            lane('input', '输入  '), lane('model', '模型  '), lane('tool', '工具  '),
            clip(r ? `${selected + 1}. ${safeText(r.name)} · ${r.kind === 'tool' ? duration(r) + ' · ' : ''}${summary(r)}` : '等待会话事件…'),
            clip(theme.fg('dim', 'Alt+, / Alt+. 选择 · Alt+I 详情 · Alt+T 隐藏 · /pitools help')),
          ];
        }),
      };
    }, { placement: 'belowEditor' });
  }
  function toggle(ctx: ExtensionContext) {
    enabled = !enabled;
    if (!enabled) closeInspector?.();
    widget(ctx); refresh();
  }
  function restore(ctx: ExtensionContext) {
    closeInspector?.();
    blockText.clear();
    streaming.clear(); missingThinkingByCall.clear(); pendingModelTimings.clear(); requestStart = undefined; firstToken = undefined;
    tuiActive = isTui(ctx); notifyCtx = ctx;
    const branch = ctx.sessionManager.getBranch();
    activity.reset(restoreActivityConfig(branch));
    store.restore(branch);
    follow = true; selected = store.records.length - 1; selectedRecord = undefined;
    widget(ctx); refresh();
    // A session boundary may start the requested worker once; failures are never auto-restarted.
    if (coreAtStart && activity.effective === 'ts' && tuiActive) { const kind = coreAtStart; coreAtStart = undefined; void startCore(ctx, kind, false); }
  }
  async function startCore(ctx: ExtensionContext, kind: 'python' | 'rust', announce = true) {
    const failure = await (kind === 'rust' ? activity.useRust() : activity.usePython());
    const name = kind === 'rust' ? 'Rust' : 'Python';
    if (failure) ctx.ui.notify(failure === 'python_not_found'
      ? 'pitools 未找到 Python 3.11+ 解释器，继续使用 TS 核心。可设置 PITOOLS_PYTHON 为解释器绝对路径；pitools 不会自动安装 Python。'
      : failure === 'rust_not_found' ? 'pitools 未找到 Rust 核心二进制，继续使用 TS 核心。可设置 PITOOLS_RUST_CORE 为可信可执行文件绝对路径；pitools 不会自动下载或编译。'
      : `pitools ${name} 核心启动失败（${failure}），继续使用 TS 核心。`, 'warning');
    else if (announce) ctx.ui.notify(`pitools 已切换到 ${name} 活动核心：${activity.status()}`, 'info');
    refresh();
  }
  async function coreCommand(args: string, ctx: ExtensionContext) {
    const choice = args.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!choice || choice === 'status' || choice === 'help') {
      ctx.ui.notify(`pitools 活动核心：${activity.status()}\n/pitools core python 启用可选 Python worker（Python 3.11+，标准库，私有管道）；/pitools core rust 启用可选 Rust worker（需要可信二进制，不自动下载/编译）；/pitools core ts 回到默认 TS 核心；/pitools core verify on|off 开关逐视图 TS 对照（诊断用，会增加 CPU）。轨迹、详情和渲染仍由 TS/Pi 原生实现。`, 'info'); return;
    }
    if (choice === 'verify on' || choice === 'verify off') {
      activity.verify = choice === 'verify on';
      ctx.ui.notify(`pitools 逐视图 TS 对照已${activity.verify ? '开启' : '关闭'}。`, 'info'); return;
    }
    if (choice === 'python' || choice === 'rust') {
      if (edition !== 'development' && choice !== edition) { ctx.ui.notify(`当前是 pitools-${edition} 独立包，不能启动 ${choice} 核心；请先移除当前包，再安装对应版本。`, 'warning'); return; }
      if (!isTui(ctx)) { ctx.ui.notify('pitools 外部活动核心只在 Pi 交互终端中启动。', 'warning'); return; }
      notifyCtx = ctx; coreAtStart = undefined; return startCore(ctx, choice);
    }
    if (choice === 'ts') { coreAtStart = undefined; activity.useTs(); ctx.ui.notify('pitools 已使用默认 TS 活动核心，外部 worker 已关闭。', 'info'); refresh(); return; }
    ctx.ui.notify('参数无效，请用 /pitools core status|python|rust|ts|verify on|verify off。', 'warning');
  }
  async function inspect(ctx: ExtensionContext) {
    if (!isTui(ctx)) { ctx.ui.notify('pitools 详情需要 Pi 交互终端。', 'warning'); return; }
    if (!store.records.length) { ctx.ui.notify('当前会话没有轨迹事件。', 'info'); return; }
    if (closeInspector) return;
    follow = false;
    if (selected < 0) selected = store.records.length - 1;
    try {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let offset = 0;
      let tab = 0;
      let plain = false;
      let pageSize = 10;
      let total = 0;
      const detailCache = new DetailCache();
      let searchMode = false;
      let focused = false;
      let filter = '';
      const search = new Input();
      const matches = () => store.records.map((r: any, i: number) => ({ r, i })).filter(({ r }: any) => !filter || `${r.name} ${summary(r)} ${r.kind === 'tool' ? outputPreview(r) : r.text}`.toLowerCase().includes(filter.toLowerCase()));
      const move = (delta: number) => {
        const rows = matches();
        const pos = rows.findIndex(({ i }: any) => i === selected);
        selected = rows[Math.max(0, Math.min(rows.length - 1, pos + delta))]?.i ?? selected;
        selectedRecord = store.records[selected];
        offset = 0; refresh();
      };
      const finish = () => { detailCache.clear(); done(); };
      closeInspector = finish;
      inspectorRepaint = () => tui.requestRender();
      return {
        get focused() { return focused; },
        set focused(value: boolean) { focused = value; search.focused = value && searchMode; },
        invalidate() { search.invalidate(); detailCache.clear(); },
        dispose() { detailCache.clear(); closeInspector = undefined; inspectorRepaint = undefined; },
        handleInput(data: string) {
          if (searchMode) {
            if (matchesKey(data, 'escape') || matchesKey(data, 'return')) { searchMode = false; search.focused = false; }
            else { search.handleInput(data); const clean = safeText(search.getValue()).replace(/\n/g, ' '); if (clean !== search.getValue()) search.setValue(clean); filter = clean; const rows = matches(); if (!rows.some(({ i }: any) => i === selected)) selected = rows[0]?.i ?? selected; selectedRecord = store.records[selected]; offset = 0; }
            tui.requestRender(); return;
          }
          if (matchesKey(data, 'escape')) return finish();
          if (matchesKey(data, 'alt+t')) { enabled = false; widget(ctx); return finish(); }
          if (data === 'r' || data === 'R') { plain = !plain; offset = 0; }
          else if (data === '/') { searchMode = true; search.focused = focused; }
          else if (matchesKey(data, 'left') || matchesKey(data, 'right')) move(matchesKey(data, 'left') ? -1 : 1);
          else if (matchesKey(data, 'tab') || matchesKey(data, 'return')) { tab++; offset = 0; }
          else if (matchesKey(data, 'up')) offset = Math.max(0, offset - 1);
          else if (matchesKey(data, 'down')) offset = Math.min(Math.max(0, total - pageSize), offset + 1);
          else if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - pageSize);
          else if (matchesKey(data, 'pageDown')) offset = Math.min(Math.max(0, total - pageSize), offset + pageSize);
          else if (matchesKey(data, 'home')) offset = 0;
          else if (matchesKey(data, 'end')) offset = Math.max(0, total - pageSize);
          tui.requestRender();
        },
        render: guarded(ctx, '详情', (width: number) => {
          const w = Math.max(1, width);
          const clip = (s: string) => truncateToWidth(s, w);
          const terminalRows = Number.isFinite(tui.terminal?.rows) ? Math.max(1, Math.floor(tui.terminal.rows)) : 24;
          if (terminalRows < 12) return [clip('pitools：窗口过矮，请放大终端；Esc 返回')];
          if (filter && !matches().length) return [clip('pitools：没有匹配事件；/ 修改搜索条件，Esc 返回'), ...(searchMode ? search.render(w).map(clip) : [])];
          const r = store.records[Math.max(0, Math.min(selected, store.records.length - 1))];
          if (!r) return [clip('轨迹已清空，Esc 返回')];
          const labels = r.kind === 'tool' ? ['概述', '参数', '结果', 'Schema', '计时'] : ['概述', '预览', '原始内容', '计时'];
          const activeTab = tab % labels.length;
          const rows = matches();
          const split = w >= 100;
          const listWidth = split ? Math.floor(w * 0.54) : w;
          const detailWidth = split ? w - listWidth - 3 : w;
          const height = Math.max(4, Math.min(28, terminalRows - 10));
          pageSize = split ? height - 2 : Math.max(1, height - 7);
          const buildLines = () => {
            const schema = r.kind === 'tool' ? r.schema ?? toolSchema(r.name) : undefined;
            const timing = timingInfo(r);
            const displayText = r.name === '思考' && r.live && !safeText(r.text).trim() ? '思考中…' : safeText(r.text);
            const thinkingNote = r.hiddenThinkingBlocks ? `\n未提供可见思考：该助手消息有 ${r.hiddenThinkingBlocks} 个空思考块，已收起；不表示推理 Token 为零。\n` : '';
            const overview = `类型：${r.kind === 'tool' ? '工具' : r.kind === 'input' ? '输入' : '助手'}\n第 ${r.turn} 轮 · 第 ${selected + 1} 步\n状态：${status(r)}\n${r.id ? `调用 ID：${safeText(r.id)}\n` : ''}${thinkingNote}`;
            const body = r.kind === 'tool'
              ? activeTab === 1 ? json(r.args) : activeTab === 2 ? json(r.result ?? (plain ? '(尚无结果；历史嵌套调用可能未保存结果)' : '(尚无结果)'))
                : activeTab === 3 ? `Schema 来源：${r.schema ? '执行开始时的工具定义' : '当前工具定义，可能与历史不同'}\n${schema ? json(schema) : '当前 Pi 未提供该工具的 Schema。'}`
                  : activeTab === 4 ? json(timing) : `${overview}\n参数\n${json(r.args)}\n\n结果\n${json(r.result ?? '(未记录)')}\n\n计时\n${json(timing)}`
              : activeTab === 1 ? displayText : activeTab === 2 ? json(r.raw ?? { text: r.text, usage: r.usage }) : activeTab === 3 ? json(timing)
                : r.kind === 'input' ? `${overview}\n提交时间\n${json(timing)}\n\n内容\n${displayText}`
                  : `${overview}\nToken（该助手消息整体用量，思考/回复共用，不应重复相加）\n${json(r.usage)}\n\n${r.name === '思考' ? '思考' : '内容'}\n${displayText}\n\n计时（助手消息整体，不是单个思考块时长）\n${json(timing)}`;
            return renderDetail(body, r, activeTab, Math.max(1, detailWidth), theme, plain);
          };
          // Only content tabs: overview/timing/schema remain dynamic. Revision
          // catches in-place event updates; invalidate/dispose drop themed lines.
          const cacheable = activeTab === 1 || activeTab === 2;
          const lines = cacheable
            ? detailCache.render([r, r.revision, activeTab, detailWidth, plain, detailThemeKey(theme)], buildLines)
            : (detailCache.clear(), buildLines());
          total = lines.length;
          offset = Math.min(offset, Math.max(0, total - pageSize));
          const center = rows.findIndex(({ i }: any) => i === selected);
          const listCount = split ? height : Math.min(5, height - 2);
          const start = Math.max(0, Math.min(center - Math.floor(listCount / 2), rows.length - listCount));
          const ledger = rows.slice(start, start + listCount).map(({ r: row, i }: any) => {
            const text = `${i === selected ? '▎' : ' '} ${row.kind === 'tool' ? '工具' : row.kind === 'input' ? '输入' : '助手'} ${safeText(row.name)} ${summary(row)}${row.kind === 'tool' ? ` → ${outputPreview(row)}` : ''}`;
            return color(theme, row.error ? 'error' : row.kind, truncateToWidth(text, listWidth));
          });
          if (!rows.length) ledger.push(truncateToWidth('没有匹配事件；/ 修改搜索条件', listWidth));
          const detail = [color(theme, r.kind, truncateToWidth(`${safeText(r.name)} · ${labels.map((label, i) => i === activeTab ? `[${label}]` : label).join(' ')}`, detailWidth)),
            ...lines.slice(offset, offset + pageSize).map(line => truncateToWidth(line, detailWidth)),
            theme.fg('muted', truncateToWidth(`行 ${offset + 1}–${Math.min(total, offset + pageSize)} / ${total}`, detailWidth))];
          const cap = Math.max(1, Math.floor((w - 6) / 2));
          const traceStart = Math.max(0, Math.min(selected - Math.floor(cap / 2), store.records.length - cap));
          const trace = store.records.slice(traceStart, traceStart + cap);
          const lane = (kind: string, label: string) => clip(label + trace.map((row: any, i: number) => row.kind === kind ? color(theme, row.error ? 'error' : kind, traceStart + i === selected ? '▣ ' : row.live ? '░ ' : '▪ ') : '· ').join(''));
          const header = [titleLine(theme, w, `pitools · 轨迹 · ${store.turn} 轮 · ${store.records.filter((x: any) => x.kind === 'tool').length} 次调用 · ${selected + 1}/${store.records.length} 步${store.hiddenThinking ? ` · 已收起 ${store.hiddenThinking} 个空思考` : ''}`, `pitools · ${store.turn}轮 · ${selected + 1}/${store.records.length}步`),
            lane('input', '输入  '), lane('model', '模型  '), lane('tool', '工具  '),
            searchMode ? clip('搜索：') : clip(theme.fg('dim', `←→ 选择 · Tab 页签 · ↑↓ 滚动 · / 搜索 · R ${plain ? '渲染' : '原文'} · Alt+T 隐藏 · Esc 返回${filter ? ` · 搜索：${safeText(filter)}` : ''}`))];
          if (searchMode) header.push(...search.render(Math.max(1, w)).map(clip));
          if (split) {
            return [...header, ...Array.from({ length: height }, (_, i) => {
              const left = ledger[i] ?? ''; return clip(left + ' '.repeat(Math.max(0, listWidth - visibleWidth(left))) + theme.fg('border', ' │ ') + (detail[i] ?? ''));
            })];
          }
          return [...header, ...ledger, clip(theme.fg('border', '─'.repeat(Math.min(w, 80)))), ...detail].slice(0, terminalRows);
        }),
      };
    });
    } finally {
      closeInspector = undefined; inspectorRepaint = undefined;
      refresh();
    }
  }
  async function activityCommand(args: string, ctx: ExtensionContext) {
    if (!isTui(ctx)) return;
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length || parts[0] === 'help') {
      ctx.ui.notify(`首行左侧活动：${json(activity.config)}\n/pitools activity on|off；frames <预设>|list（默认 pi 点阵，另有 35 种 + random）；lang zh|en|auto；narrate|contract|phrases on|off。偏好只保存到当前会话分支。`, 'info'); return;
    }
    if (parts[0] === 'frames' && (!parts[1] || parts[1] === 'list')) { ctx.ui.notify(`帧预设：random, ${FRAME_NAMES.join(', ')}`, 'info'); return; }
    const config = { ...activity.config };
    if (parts.length === 1 && ['on', 'off'].includes(parts[0])) config.enabled = parts[0] === 'on';
    else if (parts.length === 2 && parts[0] === 'frames' && (parts[1] === 'random' || FRAME_NAMES.includes(parts[1]))) config.frames = parts[1];
    else if (parts.length === 2 && parts[0] === 'lang' && ['zh', 'en', 'auto'].includes(parts[1])) config.lang = parts[1];
    else if (parts.length === 2 && ['narrate', 'contract', 'phrases'].includes(parts[0]) && ['on', 'off'].includes(parts[1])) config[parts[0]] = parts[1] === 'on';
    else { ctx.ui.notify('参数无效，请用 /pitools activity help。', 'warning'); return; }
    activity.configure(config);
    pi.appendEntry('pitools-activity-config', { schema: 1, config: activity.config });
    refresh();
  }
  pi.registerCommand('pitools', {
    description: '终端轨迹与工具调用详情：on/off/toggle/live/prev/next/activity/core/version/help',
    handler: async (args, ctx) => {
      if (/^activity(?:\s|$)/i.test(args.trim())) return activityCommand(args.trim().slice(8), ctx);
      if (/^core(?:\s|$)/i.test(args.trim())) return coreCommand(args.trim().slice(4), ctx);
      switch (args.trim().toLowerCase()) {
        case 'on': enabled = true; widget(ctx); refresh(); break;
        case 'off': enabled = false; closeInspector?.(); widget(ctx); refresh(); break;
        case 'toggle': toggle(ctx); break;
        case 'live': follow = true; refresh(); break;
        case 'prev': choose(-1); break;
        case 'next': choose(1); break;
        case 'version': ctx.ui.notify(`pitools ${VERSION} · 包类型 ${edition} · 核心 ${CORE_VERSION} · 渲染 ${RENDERER_VERSION} · 活动 ${ACTIVITY_VERSION} · 数据 ${ACTIVITY_DATA_VERSION} · Python 适配 ${PYTHON_CORE_VERSION} · 当前进程已加载 TS 模块 · Rust 适配 ${RUST_CORE_VERSION} · 活动核心 ${activity.effective === 'rust' ? 'Rust' : activity.effective === 'python' ? 'Python' : 'TS'}`, 'info'); break;
        case 'help': ctx.ui.notify('pitools：蓝色输入、紫色模型、橙色工具，失败标红。Alt+, / Alt+. 选事件；Alt+T 隐藏/显示；Alt+I 或 /pitools 打开轨迹列表与详情。详情里 ←→ 选事件，Tab 换概述/参数/结果/Schema/计时，↑↓/PgUp/PgDn 滚动，/ 搜索，R 切代码渲染/原文，Esc 关闭。宽终端左右分栏，窄终端上下布局。/pitools live 跟随最新；on/off 开关。首行最左侧显示工作月相/阶段/旁白，文字与统计统一主题强调色，仅 ● 灰/绿/红表示状态；/pitools activity help 管理；/pitools core 查看/切换可选 Python/Rust 活动核心。历史未记录的数据不会猜测。/pitools version 检查当前进程加载的版本。', 'info'); break;
        case '': await inspect(ctx); break;
        default: ctx.ui.notify('未知参数，请用 /pitools help。', 'warning');
      }
    },
  });
  pi.registerShortcut('alt+,', { description: 'pitools 上一个事件', handler: async () => choose(-1) });
  pi.registerShortcut('alt+.', { description: 'pitools 下一个事件', handler: async () => choose(1) });
  pi.registerShortcut('alt+i', { description: 'pitools 查看详情', handler: async ctx => inspect(ctx) });
  pi.registerShortcut('alt+t', { description: 'pitools 隐藏/显示轨迹', handler: async ctx => toggle(ctx) });
  pi.on('session_start', (_e, ctx) => restore(ctx));
  pi.on('before_agent_start', (event, ctx) => {
    // Own section only; preserve all other extensions' prompt sections.
    if (isTui(ctx) && enabled && activity.config.enabled && activity.config.contract && activity.config.narrate) event.systemPromptOptions.sections.pitools_activity = narrationContract(activity.lang);
    else delete event.systemPromptOptions.sections.pitools_activity;
  });
  pi.on('agent_start', () => { activity.begin(Date.now()); refresh(); });
  pi.on('turn_start', () => { activity.turnStart(Date.now()); refresh(); });
  pi.on('agent_settled', () => { activity.finish(Date.now()); refresh(); });
  pi.on('session_tree', (_e, ctx) => restore(ctx));
  pi.on('session_compact', (_e, ctx) => restore(ctx));
  pi.on('message_start', (e) => {
    if (e.message.role === 'user') {
      store.turn++;
      const submitted = validTimestamp(e.message.timestamp);
      store.add({ kind: 'input', name: '输入', text: contentText(e.message.content), turn: store.turn, recordedAt: submitted ?? Date.now(), recordedAtSource: submitted !== undefined ? 'message' : 'observed' }); refresh();
    }
    if (e.message.role === 'assistant') { blockText.clear(); streaming.clear(); requestStart = Date.now(); firstToken = undefined; activity.streamStart(requestStart); refresh(); }
  });
  pi.on('message_update', e => {
    if (e.message.role !== 'assistant') return;
    const type = e.assistantMessageEvent.type;
    if (!type.startsWith('thinking') && !type.startsWith('text')) return;
    const blocks = Array.isArray(e.message.content) ? e.message.content : [];
    const eventBlock = blocks[e.assistantMessageEvent.contentIndex];
    const delta = 'delta' in e.assistantMessageEvent ? safeText(e.assistantMessageEvent.delta) : eventBlock?.type === 'thinking' || eventBlock?.type === 'text' ? contentText([eventBlock]) : '';
    if (type.endsWith('_delta')) activity.delta(type, visibleTextTail(blocks), Date.now());
    if (type.endsWith('_delta') && firstToken === undefined && delta.trim()) firstToken = Date.now();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block?.type !== 'thinking' && block?.type !== 'text') continue;
      // A signed empty thinking block observed during a text event is not
      // evidence that visible reasoning is still being generated.
      const cleanText = blockText.get(block);
      if (block.type === 'thinking' && !cleanText.trim() && !type.startsWith('thinking') && !streaming.has(i)) continue;
      let record = streaming.get(i);
      if (!record) {
        record = store.add({ kind: 'model', name: block.type === 'thinking' ? '思考' : '回复', text: '', turn: store.turn, live: true, start: requestStart, messageAt: validTimestamp(e.message.timestamp) });
        streaming.set(i, record);
      }
      record.text = cleanText; record.raw = block;
      record.firstTokenMs = firstToken === undefined || requestStart === undefined ? undefined : Math.max(0, firstToken - requestStart);
      store.touch(record);
    }
    refresh(false);
  });
  pi.on('message_end', e => {
    if (e.message.role !== 'assistant') return;
    const blocks = Array.isArray(e.message.content) ? e.message.content : [];
    const hidden = missingThinkingCount(blocks);
    const endedAt = Date.now();
    activity.messageEnd(e.message, endedAt);
    blockText.clear();
    if (requestStart !== undefined) pendingModelTimings.set(e.message, { start: requestStart, end: endedAt, elapsed: Math.max(0, endedAt - requestStart), ...(firstToken === undefined ? {} : { firstTokenMs: Math.max(0, firstToken - requestStart) }) });
    store.hiddenThinking += hidden;
    for (let i = 0; i < blocks.length; i++) {
      const p = blocks[i];
      if (p?.type === 'toolCall' && hidden && typeof p.id === 'string') {
        const tool = store.calls.get(p.id);
        if (tool) { tool.hiddenThinkingBlocks = hidden; store.touch(tool); }
        else missingThinkingByCall.set(p.id, hidden);
      }
      if (emptyThinking(p)) {
        const placeholder = streaming.get(i);
        if (placeholder) store.remove(placeholder);
        streaming.delete(i);
        continue;
      }
      if (p?.type !== 'thinking' && p?.type !== 'text') continue;
      const r = streaming.get(i) ?? store.add({ kind: 'model', name: p.type === 'thinking' ? '思考' : '回复', turn: store.turn, start: requestStart });
      r.text = contentText([p]); r.raw = p; r.live = false; r.usage = e.message.usage; r.end = endedAt; r.hiddenThinkingBlocks = hidden; r.modelMessage = e.message; r.messageAt = validTimestamp(e.message.timestamp); r.error = e.message.stopReason === 'error'; r.aborted = e.message.stopReason === 'aborted';
      r.elapsed = requestStart === undefined ? undefined : Math.max(0, r.end - requestStart);
      r.firstTokenMs = firstToken === undefined || requestStart === undefined ? undefined : Math.max(0, firstToken - requestStart);
      store.touch(r);
    }
    for (const r of streaming.values()) {
      if (r.name === '思考' && !safeText(r.text).trim()) { store.remove(r); store.hiddenThinking++; }
      else { r.live = false; store.touch(r); }
    }
    streaming.clear(); requestStart = undefined; firstToken = undefined;
    refresh();
  });
  // message_end runs BEFORE Pi appends the assistant transcript entry. turn_end
  // is the first stable boundary with its exact persisted messageEntryId.
  pi.on('turn_end', e => {
    if (e.message.role === 'assistant' && typeof e.messageEntryId === 'string') persistModelTiming(e.message, e.messageEntryId);
  });
  pi.on('tool_execution_start', e => {
    activity.toolStart(e.toolCallId, e.toolName, e.args, Date.now());
    const r = store.start(e.toolCallId, e.toolName, e.args, Date.now(), e.parentToolCallId);
    r.schema = toolSchema(e.toolName);
    r.hiddenThinkingBlocks = missingThinkingByCall.get(e.toolCallId) ?? r.hiddenThinkingBlocks;
    missingThinkingByCall.delete(e.toolCallId);
    refresh();
  });
  pi.on('tool_execution_update', e => { const r = store.calls.get(e.toolCallId); if (r) { r.result = e.partialResult; store.touch(r); } refresh(false); });
  pi.on('tool_execution_end', e => {
    activity.toolEnd(e.toolCallId, e.isError, Date.now());
    const r = store.end(e.toolCallId, e.toolName, e.result, e.isError);
    r.hiddenThinkingBlocks = missingThinkingByCall.get(e.toolCallId) ?? r.hiddenThinkingBlocks;
    missingThinkingByCall.delete(e.toolCallId);
    // Persist execution timing only; arguments/results already belong to Pi's transcript.
    if (!e.parentToolCallId && r.elapsed !== undefined) pi.appendEntry('pitools-timing', { id: r.id, elapsed: r.elapsed, start: r.start, end: r.end });
    refresh();
  });
  pi.on('agent_end', (_event, ctx) => {
    const lastAssistant = [...(_event.messages ?? [])].reverse().find(message => message.role === 'assistant');
    activity.finish(Date.now(), lastAssistant?.stopReason ?? '');
    // Aborts/retries may bypass turn_end. Bind only by exact object identity in
    // the current branch, never by equal text or equal timestamps.
    if (pendingModelTimings.size) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry?.type === 'message' && entry.message?.role === 'assistant' && pendingModelTimings.has(entry.message)) persistModelTiming(entry.message, entry.id);
      }
      pendingModelTimings.clear();
    }
    for (const r of [...store.records]) if (r.kind === 'model') {
      if (r.live && r.name === '思考' && !safeText(r.text).trim()) { store.remove(r); store.hiddenThinking++; }
      else { if (r.live) r.incomplete = true; r.live = false; delete r.modelMessage; store.touch(r); }
    }
    blockText.clear(); streaming.clear(); missingThinkingByCall.clear(); requestStart = undefined; firstToken = undefined; refresh();
  });
  pi.on('session_shutdown', () => {
    tuiActive = false;
    if (timer) clearTimeout(timer); timer = undefined;
    if (paintTimer) clearTimeout(paintTimer); paintTimer = undefined;
    activity.reset(); activity.dispose(); blockText.clear(); repaint = undefined; inspectorRepaint = undefined; notifyCtx = undefined;
    if (activity.requested !== 'ts' && !activity.failure) coreAtStart = activity.requested; // Same instance may receive a new session_start.
    const close = closeInspector; closeInspector = undefined;
    streaming.clear(); missingThinkingByCall.clear(); pendingModelTimings.clear(); requestStart = undefined; firstToken = undefined;
    close?.();
  });
  pi.events.on('pitools:edition-owner', (next: { owner?: string }) => { next.owner = edition; });
}
