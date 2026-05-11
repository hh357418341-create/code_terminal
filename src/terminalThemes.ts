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
  "ocean",
  "jade",
  "violet",
  "rose",
  "amber",
  "classic",
];
const fallbackTerminalPreset: BuiltInTerminalThemePreset = "workbench";

export const terminalThemePresets: Record<BuiltInTerminalThemePreset, TerminalThemePalette> = {
  workbench: {
    label: "深色",
    background: "#070b10",
    foreground: "#d7dde7",
    cursor: "#8ab4ff",
    selectionBackground: "#243b5a",
    panel: "#0c1118",
    border: "#1a2433",
    muted: "#7f8b99",
    black: "#070b10",
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
    white: "#475569",
    brightBlack: "#718096",
    brightRed: "#e05260",
    brightGreen: "#38a169",
    brightYellow: "#d69e2e",
    brightBlue: "#3182ce",
    brightMagenta: "#9f7aea",
    brightCyan: "#22a6b3",
    brightWhite: "#111827",
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
  ocean: {
    label: "海洋",
    background: "#06151c",
    foreground: "#d2eef4",
    cursor: "#4dd6f4",
    selectionBackground: "#164459",
    panel: "#0a2029",
    border: "#173947",
    muted: "#7ca0aa",
    black: "#06151c",
    red: "#ff7a87",
    green: "#75e0b8",
    yellow: "#f7d56f",
    blue: "#58c7ff",
    magenta: "#b8a1ff",
    cyan: "#4dd6f4",
    white: "#d2eef4",
    brightBlack: "#63828b",
    brightRed: "#ff9aa4",
    brightGreen: "#96eccb",
    brightYellow: "#ffe390",
    brightBlue: "#86d9ff",
    brightMagenta: "#cfc0ff",
    brightCyan: "#88efff",
    brightWhite: "#ffffff",
  },
  jade: {
    label: "青玉",
    background: "#07140f",
    foreground: "#d6eadf",
    cursor: "#66d99a",
    selectionBackground: "#214834",
    panel: "#0d1f17",
    border: "#1d3a2b",
    muted: "#80a491",
    black: "#07140f",
    red: "#ef767a",
    green: "#66d99a",
    yellow: "#d8c96b",
    blue: "#72b7d8",
    magenta: "#c79be8",
    cyan: "#68d4c3",
    white: "#d6eadf",
    brightBlack: "#668070",
    brightRed: "#ff9699",
    brightGreen: "#8cf0b8",
    brightYellow: "#eee28c",
    brightBlue: "#99d3eb",
    brightMagenta: "#dcb9f4",
    brightCyan: "#8de9dc",
    brightWhite: "#ffffff",
  },
  violet: {
    label: "紫夜",
    background: "#120d1f",
    foreground: "#e4ddf4",
    cursor: "#b89cff",
    selectionBackground: "#382a5a",
    panel: "#1a132b",
    border: "#302448",
    muted: "#9a8db4",
    black: "#120d1f",
    red: "#ff7f9a",
    green: "#8bdc9f",
    yellow: "#f2d179",
    blue: "#8cbcff",
    magenta: "#c79cff",
    cyan: "#7dd8e8",
    white: "#e4ddf4",
    brightBlack: "#746889",
    brightRed: "#ffa0b4",
    brightGreen: "#a9efb8",
    brightYellow: "#ffe39d",
    brightBlue: "#b0d2ff",
    brightMagenta: "#d9bdff",
    brightCyan: "#a2edf5",
    brightWhite: "#ffffff",
  },
  rose: {
    label: "暮玫",
    background: "#1c1015",
    foreground: "#f2dce3",
    cursor: "#ff8fb3",
    selectionBackground: "#512c3a",
    panel: "#28171e",
    border: "#442733",
    muted: "#b08a98",
    black: "#1c1015",
    red: "#ff7d94",
    green: "#8edaa0",
    yellow: "#efd17a",
    blue: "#8bbcf2",
    magenta: "#ff9fca",
    cyan: "#75d6dc",
    white: "#f2dce3",
    brightBlack: "#8b6874",
    brightRed: "#ffa0ad",
    brightGreen: "#aef0bd",
    brightYellow: "#ffe49d",
    brightBlue: "#afd4ff",
    brightMagenta: "#ffc0da",
    brightCyan: "#9cecf0",
    brightWhite: "#ffffff",
  },
  amber: {
    label: "琥珀",
    background: "#17110a",
    foreground: "#eadfce",
    cursor: "#f0b85a",
    selectionBackground: "#4a3417",
    panel: "#21180d",
    border: "#3b2a17",
    muted: "#a99577",
    black: "#17110a",
    red: "#f07178",
    green: "#9cca7f",
    yellow: "#f0b85a",
    blue: "#7fb3d8",
    magenta: "#d7a7d8",
    cyan: "#73c7b7",
    white: "#eadfce",
    brightBlack: "#81705d",
    brightRed: "#ff9298",
    brightGreen: "#b9e39a",
    brightYellow: "#ffd27d",
    brightBlue: "#a3cdec",
    brightMagenta: "#edc2ed",
    brightCyan: "#98ded2",
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
  fontSize: 14,
  lineHeight: 1.28,
  background: terminalThemePresets.workbench.background,
  foreground: terminalThemePresets.workbench.foreground,
  cursor: terminalThemePresets.workbench.cursor,
};

export function clampTerminalFontSize(value: number) {
  if (!Number.isFinite(value)) return defaultTerminalAppearance.fontSize;
  return Math.min(22, Math.max(10, Math.round(value)));
}

export function clampTerminalLineHeight(value: number) {
  if (!Number.isFinite(value)) return defaultTerminalAppearance.lineHeight;
  return Math.min(1.8, Math.max(1, Math.round(value * 100) / 100));
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
  lineHeight = defaultTerminalAppearance.lineHeight,
): TerminalAppearanceSettings {
  const palette = terminalThemePresets[preset];
  return {
    preset,
    fontSize: clampTerminalFontSize(fontSize),
    lineHeight: clampTerminalLineHeight(lineHeight),
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
  const lineHeight = clampTerminalLineHeight(Number(value?.lineHeight));
  const basePreset: BuiltInTerminalThemePreset = preset === "custom" ? fallbackTerminalPreset : preset;
  const base = getTerminalPresetAppearance(basePreset, fontSize, lineHeight);

  return {
    preset,
    fontSize,
    lineHeight,
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
  const isLight = appearance.preset === "daylight";
  const isCustom = appearance.preset === "custom";
  const panel = isCustom
    ? `color-mix(in srgb, ${palette.background} 88%, ${palette.foreground} 6%)`
    : palette.panel;
  const border = isCustom
    ? `color-mix(in srgb, ${palette.foreground} 18%, ${palette.background})`
    : palette.border;
  const muted = isCustom
    ? `color-mix(in srgb, ${palette.foreground} 62%, ${palette.background})`
    : palette.muted;

  return {
    background: palette.background,
    foreground: palette.foreground,
    panel,
    border,
    muted,
    accent: palette.cursor,
    sidebar: isLight
      ? "#eef3f7"
      : isCustom
        ? `color-mix(in srgb, ${palette.background} 94%, ${palette.foreground} 4%)`
        : palette.panel,
    sidebarStrong: isLight
      ? "#e3eaf2"
      : isCustom
        ? `color-mix(in srgb, ${palette.background} 86%, ${palette.foreground} 7%)`
        : palette.background,
    sidebarBorder: border,
    sidebarText: palette.foreground,
    sidebarMuted: muted,
    sidebarSoft: isCustom
      ? `color-mix(in srgb, ${palette.foreground} 48%, ${palette.background})`
      : palette.brightBlack,
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
