import type {
  BuiltInTerminalThemePreset,
  TerminalAppearanceSettings,
  TerminalThemePreset,
} from "./types";

interface TerminalThemePalette {
  label: string;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  panel: string;
  border: string;
  muted: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const terminalThemePresetOrder: BuiltInTerminalThemePreset[] = [
  "workbench",
  "daylight",
  "midnight",
  "classic",
];
const fallbackTerminalPreset: BuiltInTerminalThemePreset = "workbench";

export const terminalThemePresets: Record<BuiltInTerminalThemePreset, TerminalThemePalette> = {
  workbench: {
    label: "深色",
    background: "#101820",
    foreground: "#d8e1e8",
    cursor: "#d8f36a",
    selectionBackground: "#33515f",
    panel: "#182129",
    border: "#24313a",
    muted: "#93a2ae",
    black: "#101820",
    red: "#ef6b73",
    green: "#7bd88f",
    yellow: "#f7d774",
    blue: "#75bfff",
    magenta: "#d7a7ff",
    cyan: "#6ed7e5",
    white: "#d8e1e8",
    brightBlack: "#6f7d86",
    brightRed: "#ff8c94",
    brightGreen: "#9af5ad",
    brightYellow: "#ffe58f",
    brightBlue: "#9fd0ff",
    brightMagenta: "#e7c7ff",
    brightCyan: "#9ef4ff",
    brightWhite: "#ffffff",
  },
  daylight: {
    label: "浅色",
    background: "#f8fafc",
    foreground: "#1f2933",
    cursor: "#1769aa",
    selectionBackground: "#cfe4f6",
    panel: "#eef3f7",
    border: "#d7e0e8",
    muted: "#667382",
    black: "#1f2933",
    red: "#c2414b",
    green: "#2f855a",
    yellow: "#b7791f",
    blue: "#1769aa",
    magenta: "#7b3fb4",
    cyan: "#108999",
    white: "#edf2f7",
    brightBlack: "#718096",
    brightRed: "#e05260",
    brightGreen: "#38a169",
    brightYellow: "#d69e2e",
    brightBlue: "#3182ce",
    brightMagenta: "#9f7aea",
    brightCyan: "#22a6b3",
    brightWhite: "#ffffff",
  },
  midnight: {
    label: "午夜",
    background: "#080d14",
    foreground: "#d6e4f0",
    cursor: "#7dd3fc",
    selectionBackground: "#26384a",
    panel: "#0d1520",
    border: "#1b2a3a",
    muted: "#8497aa",
    black: "#080d14",
    red: "#ff6b7a",
    green: "#5fe0a7",
    yellow: "#ffd166",
    blue: "#72b7ff",
    magenta: "#c69cff",
    cyan: "#64d7e8",
    white: "#d6e4f0",
    brightBlack: "#617489",
    brightRed: "#ff8d99",
    brightGreen: "#7ef0bd",
    brightYellow: "#ffe08a",
    brightBlue: "#9bcfff",
    brightMagenta: "#d9bdff",
    brightCyan: "#93edf7",
    brightWhite: "#ffffff",
  },
  classic: {
    label: "经典",
    background: "#111111",
    foreground: "#f0f0f0",
    cursor: "#ffffff",
    selectionBackground: "#3a3a3a",
    panel: "#191919",
    border: "#2c2c2c",
    muted: "#a0a0a0",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  },
};

export const defaultTerminalAppearance: TerminalAppearanceSettings = {
  preset: fallbackTerminalPreset,
  fontSize: 12,
  background: terminalThemePresets.workbench.background,
  foreground: terminalThemePresets.workbench.foreground,
  cursor: terminalThemePresets.workbench.cursor,
};

export function clampTerminalFontSize(value: number) {
  if (!Number.isFinite(value)) return defaultTerminalAppearance.fontSize;
  return Math.min(22, Math.max(10, Math.round(value)));
}

export function isTerminalThemePreset(value: unknown): value is TerminalThemePreset {
  return (
    value === "custom" ||
    terminalThemePresetOrder.includes(value as BuiltInTerminalThemePreset)
  );
}

export function sanitizeHexColor(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

export function getTerminalPresetAppearance(
  preset: BuiltInTerminalThemePreset,
  fontSize = defaultTerminalAppearance.fontSize,
): TerminalAppearanceSettings {
  const palette = terminalThemePresets[preset];
  return {
    preset,
    fontSize: clampTerminalFontSize(fontSize),
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
  };
}

export function normalizeTerminalAppearance(
  value?: Partial<TerminalAppearanceSettings> | null,
): TerminalAppearanceSettings {
  const preset = isTerminalThemePreset(value?.preset)
    ? value.preset
    : defaultTerminalAppearance.preset;
  const fontSize = clampTerminalFontSize(Number(value?.fontSize));
  const basePreset: BuiltInTerminalThemePreset = preset === "custom" ? fallbackTerminalPreset : preset;
  const base = getTerminalPresetAppearance(basePreset, fontSize);

  return {
    preset,
    fontSize,
    background: sanitizeHexColor(value?.background, base.background),
    foreground: sanitizeHexColor(value?.foreground, base.foreground),
    cursor: sanitizeHexColor(value?.cursor, base.cursor),
  };
}

export function getTerminalPalette(appearance: TerminalAppearanceSettings) {
  const basePreset: BuiltInTerminalThemePreset =
    appearance.preset === "custom" ? fallbackTerminalPreset : appearance.preset;
  const base = terminalThemePresets[basePreset];

  return {
    ...base,
    background: sanitizeHexColor(appearance.background, base.background),
    foreground: sanitizeHexColor(appearance.foreground, base.foreground),
    cursor: sanitizeHexColor(appearance.cursor, base.cursor),
  };
}

export function getTerminalChrome(appearance: TerminalAppearanceSettings) {
  const palette = getTerminalPalette(appearance);
  return {
    background: palette.background,
    foreground: palette.foreground,
    panel: palette.panel,
    border: palette.border,
    muted: palette.muted,
    accent: palette.cursor,
  };
}

export function getXtermTheme(appearance: TerminalAppearanceSettings) {
  const palette = getTerminalPalette(appearance);
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    selectionBackground: palette.selectionBackground,
    black: palette.black,
    red: palette.red,
    green: palette.green,
    yellow: palette.yellow,
    blue: palette.blue,
    magenta: palette.magenta,
    cyan: palette.cyan,
    white: palette.white,
    brightBlack: palette.brightBlack,
    brightRed: palette.brightRed,
    brightGreen: palette.brightGreen,
    brightYellow: palette.brightYellow,
    brightBlue: palette.brightBlue,
    brightMagenta: palette.brightMagenta,
    brightCyan: palette.brightCyan,
    brightWhite: palette.brightWhite,
  };
}
