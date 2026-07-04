import type { EditorTheme, SelectListTheme } from '@earendil-works/pi-tui';

// PR #496: desktop --accent = oklch(0.70 0.135 250), rendered here as truecolor ANSI.
const MAKA_LOGO_BLUE_RGB = [87, 163, 239] as const;

export const ansi = {
  bold: style(1, 22),
  dim: style(2, 22),
  italic: style(3, 23),
  underline: style(4, 24),
  strikethrough: style(9, 29),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  accent: rgb(...MAKA_LOGO_BLUE_RGB),
  reverse: style(7, 27),
};

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function editorTheme(): EditorTheme {
  return {
    borderColor: ansi.accent,
    selectList: selectListTheme(),
  };
}

export function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: ansi.accent,
    selectedText: ansi.bold,
    description: ansi.dim,
    scrollInfo: ansi.dim,
    noMatch: ansi.dim,
  };
}

function style(open: number, close: number): (text: string) => string {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

function rgb(red: number, green: number, blue: number): (text: string) => string {
  return (text) => `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}
