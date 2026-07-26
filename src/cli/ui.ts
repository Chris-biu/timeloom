import { createInterface } from 'node:readline/promises';

/**
 * Terminal presentation helpers.
 *
 * Hand-rolled rather than pulled from npm, in keeping with the zero-dependency rule,
 * but the width calculation below is not merely a chalk substitute — it is the
 * reason Chinese output lines up at all.
 */

const NO_COLOR = process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '';
const FORCE_COLOR = process.env['FORCE_COLOR'] === '1';

/**
 * ESC and the Control Sequence Introducer, built from a code point rather than
 * written as an escape sequence. Keeping literal control characters out of the
 * source means editors, diff viewers and copy-paste cannot silently mangle them.
 */
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (FORCE_COLOR) return true;
  if (NO_COLOR) return false;
  return stream.isTTY;
}

function wrap(open: number, close: number): (text: string) => string {
  return (text) => (colorEnabled() ? `${CSI}${open}m${text}${CSI}${close}m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * How many terminal columns a string occupies.
 *
 * `String.length` counts UTF-16 code units, which is wrong three separate ways for
 * the output this tool produces: CJK ideographs render two columns wide, emoji are
 * surrogate pairs that render as one or two, and combining marks render as zero.
 * Using `.length` for column alignment produces tables that look fine in English and
 * visibly break the moment a path or a summary contains Chinese.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (isZeroWidth(code)) continue;
    width += isFullWidth(code) ? 2 : 1;
  }
  return width;
}

function isZeroWidth(code: number): boolean {
  return (
    code === 0x200b ||
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x20d0 && code <= 0x20f0) ||
    (code >= 0xfe00 && code <= 0xfe0f) // variation selectors
  );
}

/** East Asian Wide and Fullwidth ranges, plus the emoji blocks that render double. */
function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function padEnd(text: string, width: number): string {
  const padding = width - displayWidth(text);
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

export function truncate(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  // A zero-column budget has no room even for the ellipsis. Returning one would break
  // the only invariant this function has.
  if (maxWidth <= 0) return '';
  if (maxWidth === 1) return '…';
  let result = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > maxWidth - 1) break;
    result += character;
    width += characterWidth;
  }
  return `${result}…`;
}

export interface Column {
  header: string;
  align?: 'left' | 'right';
  maxWidth?: number;
}

export function renderTable(columns: readonly Column[], rows: readonly string[][]): string {
  const widths = columns.map((column, index) => {
    const contentWidth = rows.reduce(
      (max, row) => Math.max(max, displayWidth(row[index] ?? '')),
      displayWidth(column.header),
    );
    return column.maxWidth === undefined ? contentWidth : Math.min(contentWidth, column.maxWidth);
  });

  const lines: string[] = [];
  lines.push(
    style.dim(
      columns
        .map((column, index) => {
          const width = widths[index] ?? 0;
          // The header is bounded exactly as the cells are. Padding it without
          // truncating lets a column narrower than its own header run wider than
          // every data row, and the whole table stops lining up.
          return padEnd(truncate(column.header, width), width);
        })
        .join('  ')
        .trimEnd(),
    ),
  );

  for (const row of rows) {
    lines.push(
      columns
        .map((column, index) => {
          const width = widths[index] ?? 0;
          const cell = truncate(row[index] ?? '', width);
          if (column.align === 'right') {
            const padding = width - displayWidth(cell);
            return padding > 0 ? ' '.repeat(padding) + cell : cell;
          }
          return padEnd(cell, width);
        })
        .join('  ')
        .trimEnd(),
    );
  }

  return lines.join('\n');
}

/**
 * Ask a yes/no question.
 *
 * Returns `null` when there is no terminal to ask. Callers must then refuse to
 * proceed rather than assume consent — a destructive default in a CI pipeline is
 * exactly how a tool like this earns a bad reputation.
 */
export async function confirm(question: string, defaultYes: boolean): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${style.dim(suffix)} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}
