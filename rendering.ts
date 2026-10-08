import type { Theme } from '@earendil-works/pi-coding-agent';
import { getLanguageFromPath, getMarkdownTheme, highlightCode } from '@earendil-works/pi-coding-agent';
import { Markdown, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { contentText, safeText } from './core.ts';

export const RENDERER_VERSION = '0.1.13';

// Fingerprint actual ANSI output, not Theme identity: Pi supplies a stable proxy
// whose palette may change. Markdown callbacks also follow the global theme.
const DETAIL_COLORS = ['mdCodeBlockBorder', 'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation'] as const;
const MARKDOWN_STYLES = ['heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote', 'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'underline', 'strikethrough'] as const;
export function detailThemeKey(theme: Theme): string {
  const markdown = getMarkdownTheme();
  return DETAIL_COLORS.map(token => theme.fg(token, 'x')).join('')
    + MARKDOWN_STYLES.map(token => markdown[token]('x')).join('');
}

/** Render text only: never execute code, open files, or fetch attachments. */
export function renderDetail(body: string, record: any, tab: number, width: number, theme: Theme, plain: boolean): string[] {
  const w = Math.max(1, width);
  const fit = (lines: string[]) => lines.map(line => truncateToWidth(line, w));
  const text = (value: string) => wrapTextWithAnsi(safeText(value), w);
  const heading = (value: string) => text(value).map(line => theme.fg('mdCodeBlockBorder', line));
  const code = (value: string, language?: string) => {
    const clean = safeText(value);
    // Syntax parsing can be expensive for huge generated files. Preserve all
    // text while falling back to plain rendering above this threshold.
    if (clean.length > 200_000) return text(clean);
    try { return wrapTextWithAnsi(highlightCode(clean, language).join('\n'), w); }
    catch { return text(clean); }
  };
  const markdown = (value: string) => {
    const clean = safeText(value);
    if (clean.length > 200_000 || w < 8) return text(clean);
    try { return fit(new Markdown(clean, 0, 0, getMarkdownTheme()).render(w)); }
    catch { return text(clean); }
  };
  if (plain) return text(body);
  if (record.kind !== 'tool') return tab === 1 ? markdown(body) : tab === 2 || tab === 3 ? code(body, 'json') : text(body);
  const args = record.args ?? {};
  const path = args.path ?? args.file_path ?? args.filePath;
  const pathLanguage = typeof path === 'string' ? getLanguageFromPath(path) : undefined;
  const name = safeText(record.name).toLowerCase();
  if (tab === 1) {
    const lines: string[] = [];
    const command = args.command;
    const source = args.code ?? args.script ?? args.content;
    if (typeof command === 'string') {
      const language = /pwsh|powershell/.test(name) ? 'powershell' : /bash|shell/.test(name) ? 'bash' : undefined;
      lines.push(...heading(`── 命令${language ? ` · ${language}` : ''} ──`), ...code(command, language), '');
    } else if (typeof source === 'string') {
      const language = typeof args.language === 'string' ? args.language : pathLanguage;
      lines.push(...heading(`── 代码${language ? ` · ${language}` : ''} ──`), ...code(source, language), '');
    }
    return [...lines, ...heading('── 完整参数 · JSON ──'), ...code(body, 'json')];
  }
  if (tab === 2) {
    const output = contentText(record.result?.content);
    const lines: string[] = [];
    if (output) {
      lines.push(...heading('── 输出 ──'));
      if (name === 'read' && pathLanguage && pathLanguage !== 'markdown') lines.push(...code(output, pathLanguage));
      else if (/^\s*```/m.test(output) || (name === 'read' && pathLanguage === 'markdown')) lines.push(...markdown(output));
      else lines.push(...text(output));
      lines.push('');
    }
    return [...lines, ...heading('── 完整结果 · JSON ──'), ...code(body, 'json')];
  }
  return tab === 3 ? code(body, 'json') : text(body);
}
