import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { formatPastedImagePath, getClipboardImageItem, saveClipboardImage } from "./clipboardImages";
import { createClientId } from "./ids";
import { invoke, isTauriRuntime, listen } from "./tauriRuntime";
import { getXtermTheme } from "./terminalThemes";
import type {
  TerminalAppearanceSettings,
  TerminalCommandRequest,
  TerminalExit,
  TerminalOutput,
  TerminalStarted,
} from "./types";

const outputChunkSize = 4096;
const outputCursorRevealDelayMs = 2400;
const tuiOutputCursorRevealDelayMs = 8000;
const resizeDebounceMs = 40;
const resizeSettleDelays = [80, 180, 360];
const terminalHostSizeEpsilon = 1;
const browserPreviewMessage =
  "Browser preview mode: native terminal sessions run only inside the Tauri app.";
const conversationOutputMergeWindowMs = 1200;
const maxConversationMessages = 160;
const maxConversationMessageChars = 12000;
const liveTuiSnapshotDebounceMs = 180;
const maxLiveTuiSnapshotChars = 6000;
const maxLiveTuiTranscriptChars = 32000;
const bracketedPasteSubmitDelayMs = 180;
const terminalTuiImeStabilizeHoldMs = 900;
const codexStatusWords = ["Working", "Thinking", "Reading", "Editing", "Running", "Inspecting"];
const terminalViewModeStorageKey = "code-terminal-view-mode";
const tuiRenderDebugStorageKey = "code-terminal.tui-render-debug";
const lightTuiBackgroundAnsi = ["48", "2", "230", "237", "243"];
const ansi256ColorLevels = [0, 95, 135, 175, 215, 255];
const tuiRenderDebugEnabled = readTuiRenderDebugEnabled();
const tuiDebugFlushDelayMs = 120;
const tuiDebugTextPreviewChars = 220;

let tuiDebugLogReady: Promise<void> | null = null;
let tuiDebugLogPath: string | null = null;

function readTuiRenderDebugEnabled() {
  try {
    return window.localStorage.getItem(tuiRenderDebugStorageKey) === "1";
  } catch {
    return false;
  }
}

function ensureTuiDebugLogReady() {
  if (!tuiRenderDebugEnabled || !isTauriRuntime()) return Promise.resolve();
  if (!tuiDebugLogReady) {
    tuiDebugLogReady = invoke<string>("clear_tui_debug_log")
      .then((path) => {
        tuiDebugLogPath = path || null;
      })
      .catch(() => undefined);
  }

  return tuiDebugLogReady;
}

type ConversationRole = "user" | "terminal";
type ConversationMessageKind = "normal" | "tui";
type TerminalViewMode = "dialog" | "terminal";

interface TerminalTouchScrollState {
  touchId: number;
  lastClientY: number;
  accumulatedDelta: number;
}

interface ConversationLine {
  text: string;
  muted?: boolean;
  role?: ConversationRole;
}

interface TerminalBufferCellSnapshot {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  isDim(): number;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
}

interface TerminalBufferLineSnapshot {
  readonly length: number;
  getCell(x: number): TerminalBufferCellSnapshot | undefined;
}

interface ConversationMessage {
  id: string;
  role: ConversationRole;
  kind?: ConversationMessageKind;
  text: string;
  lines?: ConversationLine[];
  tuiGroupId?: string;
  createdAt: number;
  updatedAt: number;
}

interface TuiContextUsage {
  percent: number;
  mode: "left" | "used";
}

function getHexColorLuminance(value: string) {
  const match = value.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return 0;

  const color = Number.parseInt(match[1], 16);
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function getAnsi256Color(index: number) {
  if (index < 0 || index > 255) return null;
  if (index === 0) return { red: 0, green: 0, blue: 0 };
  if (index === 8) return { red: 128, green: 128, blue: 128 };
  if (index < 16) return null;

  if (index < 232) {
    const colorIndex = index - 16;
    return {
      red: ansi256ColorLevels[Math.floor(colorIndex / 36)],
      green: ansi256ColorLevels[Math.floor((colorIndex % 36) / 6)],
      blue: ansi256ColorLevels[colorIndex % 6],
    };
  }

  const gray = 8 + (index - 232) * 10;
  return { red: gray, green: gray, blue: gray };
}

function isDarkBackgroundColor(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance < 96 && (max - min <= 28 || max < 72);
}

function shouldUseLightTuiBackground(appearance: TerminalAppearanceSettings) {
  return appearance.preset === "daylight" || getHexColorLuminance(appearance.background) >= 210;
}

function mapLightThemeTuiBackgrounds(data: string, appearance: TerminalAppearanceSettings) {
  if (!shouldUseLightTuiBackground(appearance)) return data;

  return data.replace(/\x1b\[([0-9;:]*)m/g, (sequence, rawParams: string) => {
    const params = (rawParams || "0").split(/[;:]/);
    const nextParams: string[] = [];
    let changed = false;

    for (let index = 0; index < params.length; index += 1) {
      const param = Number(params[index] || 0);
      const mode = Number(params[index + 1]);

      if (param === 48 && mode === 5 && index + 2 < params.length) {
        const colorIndex = Number(params[index + 2]);
        const color = getAnsi256Color(colorIndex);
        if (color && isDarkBackgroundColor(color.red, color.green, color.blue)) {
          nextParams.push(...lightTuiBackgroundAnsi);
          index += 2;
          changed = true;
          continue;
        }
      }

      if (param === 48 && mode === 2 && index + 4 < params.length) {
        const red = Number(params[index + 2]);
        const green = Number(params[index + 3]);
        const blue = Number(params[index + 4]);
        if (isDarkBackgroundColor(red, green, blue)) {
          nextParams.push(...lightTuiBackgroundAnsi);
          index += 4;
          changed = true;
          continue;
        }
      }

      nextParams.push(params[index] || "0");
    }

    return changed ? `\x1b[${nextParams.join(";")}m` : sequence;
  });
}

export interface TerminalSessionRuntime {
  session: TerminalStarted | null;
  isStarting: boolean;
}

export interface TerminalSessionHandle {
  restartSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  focus: () => void;
  fit: () => void;
  interrupt: () => void;
  sendRawInput: (input: string) => void;
  sendComposerInput: (input: string) => void;
}

interface TerminalSessionViewProps {
  tabId: string;
  isActive: boolean;
  isVisible: boolean;
  activeProjectId?: string | null;
  appearance: TerminalAppearanceSettings;
  commandRequest?: TerminalCommandRequest | null;
  onError: (message: string) => void;
  onRuntimeChange: (tabId: string, runtime: TerminalSessionRuntime) => void;
}

export const TerminalSessionView = forwardRef<TerminalSessionHandle, TerminalSessionViewProps>(
  function TerminalSessionView(
    {
      tabId,
      isActive,
      isVisible,
      activeProjectId,
      appearance,
      commandRequest,
      onError,
      onRuntimeChange,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const activeProjectIdRef = useRef(activeProjectId);
    const conversationLogRef = useRef<HTMLDivElement | null>(null);
    const startingSessionIdRef = useRef<string | null>(null);
    const pendingStartSessionRef = useRef(false);
    const resizeTimerRef = useRef<number | null>(null);
    const resizeFrameRef = useRef<number | null>(null);
    const resizeSettleTimersRef = useRef<number[]>([]);
    const isStartingRef = useRef(false);
    const isActiveRef = useRef(isActive);
    const isVisibleRef = useRef(isVisible);
    const pendingRawInputRef = useRef<string | null>(null);
    const lastCommandIdRef = useRef<number | null>(null);
    const isLifecycleStoppingRef = useRef(false);
    const outputQueueRef = useRef<string[]>([]);
    const outputWriterActiveRef = useRef(false);
    const outputCursorTimerRef = useRef<number | null>(null);
    const outputCursorSuppressedRef = useRef(false);
    const terminalTuiImeStableRef = useRef(false);
    const terminalImeCompositionActiveRef = useRef(false);
    const terminalImeStabilizeHoldRef = useRef(false);
    const terminalImeStabilizeHoldTimerRef = useRef<number | null>(null);
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const lastFitHostSizeRef = useRef<{ width: number; height: number } | null>(null);
    const recentUserInputsRef = useRef<string[]>([]);
    const pendingEchoInputsRef = useRef<string[]>([]);
    const liveTuiMessageIdRef = useRef<string | null>(null);
    const liveTuiSnapshotTimerRef = useRef<number | null>(null);
    const liveTuiOutputQueuedRef = useRef(false);
    const liveTuiSnapshotStartRowRef = useRef<number | null>(null);
    const liveTuiTranscriptRowsRef = useRef<ConversationLine[]>([]);
    const directTerminalInputDraftRef = useRef("");
    const directTerminalBracketedPasteRef = useRef(false);
    const codexWelcomeMessageIdRef = useRef<string | null>(null);
    const dialogConversationStartedRef = useRef(false);
    const pendingSubmitTimerRef = useRef<number | null>(null);
    const tuiDebugLinesRef = useRef<string[]>([]);
    const tuiDebugFlushTimerRef = useRef<number | null>(null);
    const tuiDebugSequenceRef = useRef(0);
    const lastFocusDebugTargetRef = useRef<string | null>(null);
    const lastCursorDebugSignatureRef = useRef<string | null>(null);
    const lastSnapshotDebugSignatureRef = useRef<string | null>(null);
    const terminalTouchScrollRef = useRef<TerminalTouchScrollState | null>(null);
    const viewModeRef = useRef<TerminalViewMode>("terminal");
    const [session, setSession] = useState<TerminalStarted | null>(null);
    const [isStarting, setIsStarting] = useState(false);
    const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
    const [tuiContextUsage, setTuiContextUsage] = useState<TuiContextUsage | null>(null);
    const [viewMode, setViewMode] = useState<TerminalViewMode>(() => {
      try {
        const savedViewMode = localStorage.getItem(terminalViewModeStorageKey);
        return savedViewMode === "dialog" || savedViewMode === "terminal" ? savedViewMode : "terminal";
      } catch {
        return "terminal";
      }
    });
    activeProjectIdRef.current = activeProjectId;
    viewModeRef.current = viewMode;

    function shouldSuppressTerminalError(err: unknown) {
      const message = String(err);
      return (
        isLifecycleStoppingRef.current ||
        message.includes("终端会话不存在") ||
        message.includes("terminal session") ||
        message.includes("channel closed")
      );
    }

    function reportTerminalError(err: unknown) {
      if (shouldSuppressTerminalError(err)) return;
      onError(String(err));
    }

    function safeDebugText(value: string, maxLength = tuiDebugTextPreviewChars) {
      return stripAnsiSequences(value)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
    }

    function getElementDebugTarget(element: Element | null) {
      if (!element) return "none";
      if (element === terminalRef.current?.textarea) return "xterm-textarea";
      if (element === hostRef.current) return "terminal-host";
      if (hostRef.current?.contains(element)) return `${element.tagName.toLowerCase()}.inside-terminal-host`;
      if (conversationLogRef.current?.contains(element)) return `${element.tagName.toLowerCase()}.inside-dialog-log`;
      if (element instanceof HTMLElement) {
        const className = String(element.className || "").trim().replace(/\s+/g, ".");
        return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
      }

      return element.tagName.toLowerCase();
    }

    function getTerminalDebugState() {
      const terminal = terminalRef.current;
      const buffer = terminal?.buffer.active;
      const host = hostRef.current;
      const textarea = terminal?.textarea ?? null;
      const activeElement = document.activeElement;
      const context = tuiContextUsage;

      return {
        tabId,
        sessionId: sessionIdRef.current,
        viewMode: viewModeRef.current,
        active: isActiveRef.current,
        visible: isVisibleRef.current,
        activeElement: getElementDebugTarget(activeElement),
        textareaFocused: Boolean(textarea && activeElement === textarea),
        hostVisible: host ? window.getComputedStyle(host).visibility : null,
        hostOpacity: host ? window.getComputedStyle(host).opacity : null,
        hostClasses: host ? Array.from(host.classList).sort().join(" ") : null,
        outputWriterActive: outputWriterActiveRef.current,
        outputQueueLength: outputQueueRef.current.length,
        outputCursorSuppressed: outputCursorSuppressedRef.current,
        terminalTuiImeStable: terminalTuiImeStableRef.current,
        terminalImeCompositionActive: terminalImeCompositionActiveRef.current,
        terminalImeStabilizeHold: terminalImeStabilizeHoldRef.current,
        liveTuiOutputQueued: liveTuiOutputQueuedRef.current,
        liveTuiMessageId: liveTuiMessageIdRef.current,
        liveTuiSnapshotStartRow: liveTuiSnapshotStartRowRef.current,
        liveTuiTranscriptRows: liveTuiTranscriptRowsRef.current.length,
        dialogConversationStarted: dialogConversationStartedRef.current,
        contextUsage: context ? `${context.percent}:${context.mode}` : null,
        terminal: terminal
          ? {
              cols: terminal.cols,
              rows: terminal.rows,
              bufferType: buffer?.type,
              baseY: buffer?.baseY,
              cursorX: buffer?.cursorX,
              cursorY: buffer?.cursorY,
              length: buffer?.length,
            }
          : null,
      };
    }

    function summarizeDebugRows(rows: ConversationLine[]) {
      const texts = rows.map((row) => row.text);
      const nonEmptyTexts = texts.filter((text) => text.trim());
      const tail = nonEmptyTexts.slice(-4).map((text) => safeDebugText(text, 120));

      return {
        count: rows.length,
        nonEmptyCount: nonEmptyTexts.length,
        tail,
        hasFooter: texts.some(isCodexTuiFooterLine),
        hasActivePrompt: texts.some(isCodexTuiActivePromptLine),
        hasContext: texts.some((text) => /\bContext\s+\d{1,3}%\s+(?:left|used)\b/i.test(text)),
      };
    }

    function flushTuiDebugLog() {
      if (!tuiRenderDebugEnabled || !isTauriRuntime()) return;
      if (tuiDebugFlushTimerRef.current) {
        window.clearTimeout(tuiDebugFlushTimerRef.current);
        tuiDebugFlushTimerRef.current = null;
      }

      const lines = tuiDebugLinesRef.current.splice(0, tuiDebugLinesRef.current.length);
      if (lines.length === 0) return;

      void ensureTuiDebugLogReady()
        .then(() => invoke("append_tui_debug_log", { lines }))
        .catch(() => undefined);
    }

    function writeTuiDebugLog(event: string, data: Record<string, unknown> = {}) {
      if (!tuiRenderDebugEnabled || !isTauriRuntime()) return;

      tuiDebugSequenceRef.current += 1;
      const payload = {
        seq: tuiDebugSequenceRef.current,
        time: new Date().toISOString(),
        event,
        logPath: tuiDebugLogPath,
        ...getTerminalDebugState(),
        ...data,
      };

      try {
        tuiDebugLinesRef.current.push(JSON.stringify(payload));
      } catch {
        tuiDebugLinesRef.current.push(
          JSON.stringify({
            seq: tuiDebugSequenceRef.current,
            time: new Date().toISOString(),
            event,
            serializationError: true,
          }),
        );
      }

      if (!tuiDebugFlushTimerRef.current) {
        tuiDebugFlushTimerRef.current = window.setTimeout(flushTuiDebugLog, tuiDebugFlushDelayMs);
      }
    }

    function logFocusDebug(event: string) {
      const activeElement = getElementDebugTarget(document.activeElement);
      const signature = `${event}:${activeElement}:${viewModeRef.current}`;
      if (signature === lastFocusDebugTargetRef.current) return;
      lastFocusDebugTargetRef.current = signature;
      writeTuiDebugLog(event, { activeElement });
    }

    function logCursorDebug(event: string) {
      const terminal = terminalRef.current;
      const buffer = terminal?.buffer.active;
      const signature = [
        event,
        viewModeRef.current,
        buffer?.type,
        buffer?.baseY,
        buffer?.cursorX,
        buffer?.cursorY,
        outputCursorSuppressedRef.current,
        liveTuiOutputQueuedRef.current,
      ].join(":");
      if (signature === lastCursorDebugSignatureRef.current) return;
      lastCursorDebugSignatureRef.current = signature;
      writeTuiDebugLog(event);
    }

    function createConversationId() {
      return createClientId();
    }

    function parseTuiContextUsage(value: string) {
      const text = stripAnsiSequences(value).replace(/\s+/g, " ");
      const match = text.match(/\bContext\s+(\d{1,3})%\s+(left|used)\b/i);
      if (!match) return null;

      return {
        percent: Math.min(Math.max(Number(match[1]), 0), 100),
        mode: match[2].toLowerCase() === "used" ? "used" : "left",
      } satisfies TuiContextUsage;
    }

    function updateTuiContextUsageFromText(value: string) {
      const usage = parseTuiContextUsage(value);
      if (!usage) return;

      setTuiContextUsage((current) => {
        if (current?.percent === usage.percent && current.mode === usage.mode) {
          return current;
        }

        writeTuiDebugLog("context-usage-update", {
          from: current ? `${current.percent}:${current.mode}` : null,
          to: `${usage.percent}:${usage.mode}`,
          text: safeDebugText(value),
        });
        return usage;
      });
    }

    function getTuiContextUsedPercent(usage: TuiContextUsage) {
      return usage.mode === "used" ? usage.percent : 100 - usage.percent;
    }

    function getTuiContextLabel(usage: TuiContextUsage) {
      const usedPercent = getTuiContextUsedPercent(usage);
      return `上下文 ${usedPercent}%`;
    }

    function getTuiContextTitle(usage: TuiContextUsage) {
      const usedPercent = getTuiContextUsedPercent(usage);
      const leftPercent = 100 - usedPercent;
      return `上下文占用 ${usedPercent}%，剩余 ${leftPercent}%`;
    }

    function stripAnsiSequences(value: string) {
      const text = value
        .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[@-Z\\-_]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");

      const chars: string[] = [];
      for (const character of text) {
        if (character === "\b") {
          chars.pop();
        } else {
          chars.push(character);
        }
      }

      return chars
        .join("")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{4,}/g, "\n\n\n");
    }

    function hasStandaloneCarriageReturn(value: string) {
      return /\r(?!\n)/.test(value);
    }

    function hasDynamicTerminalControl(value: string) {
      return (
        hasStandaloneCarriageReturn(value) ||
        /\x1b\[[0-?]*[ -/]*[ABCDHSTfHLsu]/.test(value) ||
        hasInteractivePrivateModeEnable(value) ||
        /\x1b[78=>]/.test(value)
      );
    }

    function hasInteractivePrivateModeEnable(value: string) {
      const interactivePrivateModes = new Set(["47", "1000", "1002", "1003", "1005", "1006", "1015", "1047", "1048", "1049"]);
      const matches = value.matchAll(/\x1b\[\?([0-9;]*)h/g);

      for (const match of matches) {
        const modes = match[1].split(";").filter(Boolean);
        if (modes.some((mode) => interactivePrivateModes.has(mode))) {
          return true;
        }
      }

      return false;
    }

    function hasAlternateBufferDisable(value: string) {
      return /\x1b\[\?(?:47|1047|1049)l/.test(value);
    }

    function hasSnapshotVisibleText(value: string) {
      return Boolean(stripAnsiSequences(value).trim());
    }

    function looksLikeCodexStatusFrame(value: string) {
      const text = stripAnsiSequences(value).replace(/\s+/g, " ").trim();
      if (!text) return false;

      return (
        /\besc to interrupt\b/i.test(text) ||
        /\bContext\s+\d+%/i.test(text) ||
        /^[•●◦○]?\s*(Working|Thinking|Reading|Editing|Running)\b/i.test(text)
      );
    }

    function shouldUseLiveTerminalOutput(value: string) {
      return hasDynamicTerminalControl(value) || looksLikeCodexStatusFrame(value);
    }

    function stripPromptPrefix(line: string) {
      const powerShellPrompt = line.match(/^PS\s.+?>\s*(.*)$/);
      if (powerShellPrompt) return powerShellPrompt[1].trim();

      const shellPrompt = line.match(/^[\w.-]+@[\w.-]+:.*[#$]\s*(.*)$/);
      if (shellPrompt) return shellPrompt[1].trim();

      const simpleShellPrompt = line.match(/^[#$]\s+(.*)$/);
      if (simpleShellPrompt) return simpleShellPrompt[1].trim();

      return line.trim();
    }

    function formatTerminalConversationText(value: string) {
      const recentUserInputs = new Set(recentUserInputsRef.current.map((input) => input.trim()).filter(Boolean));
      const lines = stripAnsiSequences(value)
        .split("\n")
        .map(stripPromptPrefix)
        .filter((line) => {
          const trimmedLine = line.trim();
          return trimmedLine && !recentUserInputs.has(trimmedLine) && !consumePendingEchoLine(trimmedLine);
        });

      return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
    }

    function stripPromptPrefixForSnapshot(line: string) {
      const powerShellPrompt = line.match(/^PS\s.+?>\s*(.*)$/);
      if (powerShellPrompt) return powerShellPrompt[1].trimEnd();

      const shellPrompt = line.match(/^[\w.-]+@[\w.-]+:.*[#$]\s*(.*)$/);
      if (shellPrompt) return shellPrompt[1].trimEnd();

      const simpleShellPrompt = line.match(/^[#$]\s+(.*)$/);
      if (simpleShellPrompt) return simpleShellPrompt[1].trimEnd();

      return line.trimEnd();
    }

    function stripPromptPrefixForSnapshotRow(row: ConversationLine): ConversationLine {
      const strippedText = stripPromptPrefixForSnapshot(row.text);
      return strippedText === row.text ? row : { ...row, text: strippedText };
    }

    function normalizeEchoComparison(value: string) {
      return value.replace(/\s+/g, " ").trim();
    }

    function isRecentInputSnapshotEchoFragment(line: string, allowShortFragments: boolean) {
      const normalizedLine = normalizeEchoComparison(line);
      if (!normalizedLine) return false;

      return recentUserInputsRef.current.some((input) => {
        const normalizedInput = normalizeEchoComparison(input);
        if (!normalizedInput) return false;
        if (normalizedInput === normalizedLine) return true;
        return allowShortFragments && normalizedLine.length >= 3 && normalizedInput.includes(normalizedLine);
      });
    }

    function hasCodexTuiChrome(lines: string[]) {
      return lines.some((line) => {
        const normalizedLine = normalizeEchoComparison(line);
        return (
          isCodexTuiWelcomeOrPromptChromeLine(normalizedLine) ||
          isCodexTuiFooterLine(normalizedLine) ||
          isCodexTuiActivePromptLine(normalizedLine) ||
          /^╭|^╰|^│/.test(normalizedLine) ||
          /\bOpenAI Codex\b/i.test(normalizedLine) ||
          /\b(model|directory|permissions):/i.test(normalizedLine) ||
          /\bTip:\b/i.test(normalizedLine) ||
          /\besc to interrupt\b/i.test(normalizedLine) ||
          /\bContext\s+\d+%\s+(?:left|used)\b/i.test(normalizedLine) ||
          /\bgpt-[\w.-]+/i.test(normalizedLine) ||
          /[>›]\s*Improve\b/i.test(normalizedLine) ||
          /@filename/i.test(normalizedLine)
        );
      });
    }

    function getCodexStatusWord(line: string) {
      const normalizedLine = normalizeEchoComparison(line.replace(/^[•●◦○?]\s*/, ""));
      if (!normalizedLine) return null;

      for (const statusWord of codexStatusWords) {
        const normalizedStatusWord = statusWord.toLowerCase();
        const normalizedCandidate = normalizedLine.toLowerCase();
        if (
          normalizedCandidate === normalizedStatusWord ||
          normalizedStatusWord.startsWith(normalizedCandidate) ||
          normalizedStatusWord.endsWith(normalizedCandidate)
        ) {
          return statusWord;
        }
      }

      return null;
    }

    function getCodexStatusFragmentWord(value: string) {
      const normalizedValue = normalizeEchoComparison(value.replace(/[•●◦○·?]/g, " "));
      if (!normalizedValue) return null;

      const fragments = normalizedValue.split(/\s+/);
      let matchedStatusWord: string | null = null;

      for (const fragment of fragments) {
        const normalizedFragment = fragment.toLowerCase();
        const statusWord = codexStatusWords.find((candidate) => {
          const normalizedCandidate = candidate.toLowerCase();
          return (
            normalizedCandidate === normalizedFragment ||
            normalizedCandidate.startsWith(normalizedFragment) ||
            normalizedCandidate.endsWith(normalizedFragment)
          );
        });

        if (!statusWord) return null;
        matchedStatusWord = statusWord;
      }

      return matchedStatusWord;
    }

    function isCodexTuiFooterLine(line: string) {
      const text = normalizeEchoComparison(line);
      if (!text) return false;

      return (
        /\bContext\s+\d{1,3}%\s+(?:left|used)\b/i.test(text) ||
        /\btab\s+to\s+queue\s+message\b/i.test(text) ||
        /\besc\s+to\s+interrupt\b/i.test(text) ||
        /\benter\s+to\s+send\b/i.test(text) ||
        /\bctrl\+j\s+for\s+new\s+line\b/i.test(text) ||
        /\bshift\+enter\s+for\s+new\s+line\b/i.test(text)
      );
    }

    function isCodexTuiActivePromptLine(line: string) {
      const text = normalizeEchoComparison(line);
      if (!text) return false;

      return /^[>›]\s*(?:$|[_▌█|]\s*$)/.test(text);
    }

    function isCodexTuiPromptInputLine(line: string) {
      const text = normalizeEchoComparison(line);
      if (!text || /[>›]\s*Improve\b/i.test(text)) return false;

      return isCodexTuiActivePromptLine(text) || /^[>›]\s+\S/.test(text);
    }

    function getCodexCurrentPromptRowIndexes(lines: string[]) {
      const promptRowIndexes = new Set<number>();
      let lastContentIndex = -1;
      let hasFooterTail = false;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const text = lines[index].trim();
        if (!text) continue;

        if (isCodexTuiFooterLine(text) || isCodexTuiNoiseLine(text, true)) {
          hasFooterTail = true;
          continue;
        }

        lastContentIndex = index;
        break;
      }

      if (lastContentIndex < 0) return promptRowIndexes;

      const promptSearchStart = Math.max(0, lastContentIndex - 6);
      for (let index = lastContentIndex; index >= promptSearchStart; index -= 1) {
        if (!isCodexTuiPromptInputLine(lines[index])) continue;

        if (hasFooterTail || isCodexTuiActivePromptLine(lines[index])) {
          for (let promptIndex = index; promptIndex <= lastContentIndex; promptIndex += 1) {
            promptRowIndexes.add(promptIndex);
          }
        }
        break;
      }

      return promptRowIndexes;
    }

    function isCodexTuiNoiseLine(line: string, shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return false;

      const text = line.trim();
      if (!text) return false;
      if (isCodexTuiFooterLine(text) || isCodexTuiActivePromptLine(text)) return true;
      if (/^[•●◦○·?\s\d]+$/.test(text)) return true;
      if (getCodexStatusFragmentWord(text)) return false;

      return false;
    }

    function isCodexTuiWelcomeOrPromptChromeLine(line: string) {
      const text = normalizeEchoComparison(line);
      if (!text) return false;

      return (
        /\bOpenAI Codex\b/i.test(text) ||
        /\bBuild faster with Codex\b/i.test(text) ||
        /\bUse \/skills\b/i.test(text) ||
        /\bUse \/status\b/i.test(text) ||
        /\bcurrent model,\s*approvals,\s*and token usage\b/i.test(text) ||
        /\bapprovals,\s*and token usage\b/i.test(text) ||
        /\bYou can resume a previous conversation\b/i.test(text) ||
        /^Tip:?\b/i.test(text) ||
        /^by running\b/i.test(text) ||
        /^codex resume$/i.test(text) ||
        /^code$/i.test(text) ||
        /^Implement\s+\{feature\}$/i.test(text) ||
        /\bSummarize recent commits\b/i.test(text) ||
        /\bFind and fix a bug in @filename\b/i.test(text) ||
        /\bImprove documentation in @filename\b/i.test(text)
      );
    }

    function getCodexHistoricalUserLineText(line: string) {
      const text = line.trimEnd();
      const match = text.match(/^\s*[>›]\s+(.+)$/);
      if (!match || /[>›]\s*Improve\b/i.test(text)) return null;

      return match[1].trimEnd();
    }

    function cleanCodexTuiChromeLine(line: string, shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return line;

      let text = line.trimEnd();
      const historicalUserLineText = getCodexHistoricalUserLineText(text);
      if (historicalUserLineText !== null) {
        return historicalUserLineText;
      }

      if (/^[╭╰─│\s>_OpenAI Codex().v0-9]+$/.test(text)) return "";
      if (/^\s*│/.test(text)) return "";
      if (/^\s*╭/.test(text) || /^\s*╰/.test(text)) return "";
      if (isCodexTuiWelcomeOrPromptChromeLine(text)) return "";
      if (isCodexTuiFooterLine(text) || isCodexTuiActivePromptLine(text)) return "";
      if (/\bOpenAI Codex\b/i.test(text)) return "";
      if (/\b(model|directory|permissions):/i.test(text)) return "";
      if (/\bTip:\b/i.test(text)) return "";
      text = text.replace(/[>›]\s*Improve.*$/i, "").trimEnd();
      text = text.replace(/\([^)]*\besc to interrupt\b[^)]*\)/gi, "").trimEnd();

      if (/\bContext\s+\d+%\s+(?:left|used)\b/i.test(text)) {
        return "";
      }

      if (/^\s*>/.test(text)) return "";
      if (/\besc to interrupt\b/i.test(text)) return "";
      if (isCodexTuiNoiseLine(text, shouldCleanCodexChrome)) return "";
      text = text.replace(/^\s*[•●◦○]\s+/, "").trimEnd();

      return text;
    }

    function isCodexTuiChromeLine(line: string) {
      const text = normalizeEchoComparison(line);
      if (!text) return false;
      if (/^[>›]\s+\S/.test(text) && !/[>›]\s*Improve\b/i.test(text)) return false;

      return (
        isCodexTuiWelcomeOrPromptChromeLine(text) ||
        isCodexTuiFooterLine(text) ||
        isCodexTuiActivePromptLine(text) ||
        /^╭|^╰|^│/.test(text) ||
        /\bOpenAI Codex\b/i.test(text) ||
        /\b(model|directory|permissions):/i.test(text) ||
        /\bTip:\b/i.test(text) ||
        /^[>›]/.test(text) ||
        /\besc to interrupt\b/i.test(text) ||
        /\bContext\s+\d+%\s+(?:left|used)\b/i.test(text) ||
        /\bgpt-[\w.-]+/i.test(text) ||
        /[>›]\s*Improve\b/i.test(text) ||
        /@filename/i.test(text)
      );
    }

    function cleanCodexSnapshotLines(lines: string[], shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return lines;

      const contentLines: string[] = [];
      for (const line of lines) {
        const statusWord = getCodexStatusWord(line) ?? getCodexStatusFragmentWord(line);
        if (statusWord) {
          continue;
        }

        if (isCodexTuiChromeLine(line) || isCodexTuiNoiseLine(line, true)) {
          continue;
        }

        contentLines.push(line);
      }

      while (contentLines.length > 0 && !contentLines[0].trim()) {
        contentLines.shift();
      }
      while (contentLines.length > 0 && !contentLines[contentLines.length - 1].trim()) {
        contentLines.pop();
      }

      return contentLines;
    }

    function dropWrappedEchoPrefix(lines: string[]) {
      const recentInputs = recentUserInputsRef.current
        .map(normalizeEchoComparison)
        .filter(Boolean)
        .sort((first, second) => second.length - first.length);

      for (const input of recentInputs) {
        let joinedLines = "";

        for (let index = 0; index < Math.min(lines.length, 8); index += 1) {
          joinedLines += lines[index].trimEnd();
          const normalizedJoinedLines = normalizeEchoComparison(joinedLines);
          if (!normalizedJoinedLines) continue;

          if (normalizedJoinedLines === input) {
            return lines.slice(index + 1);
          }

          if (!input.startsWith(normalizedJoinedLines)) {
            break;
          }
        }
      }

      return lines;
    }

    function trimConversationRows(rows: ConversationLine[]) {
      const nextRows = [...rows];
      while (nextRows.length > 0 && !nextRows[0].text.trim()) {
        nextRows.shift();
      }
      while (nextRows.length > 0 && !nextRows[nextRows.length - 1].text.trim()) {
        nextRows.pop();
      }
      return nextRows;
    }

    function compactConversationRows(rows: ConversationLine[]) {
      const compactRows: ConversationLine[] = [];
      let blankLineCount = 0;

      for (const row of rows) {
        if (!row.text.trim()) {
          blankLineCount += 1;
          if (blankLineCount <= 2) {
            compactRows.push({ text: "" });
          }
          continue;
        }

        blankLineCount = 0;
        compactRows.push(row);
      }

      return compactRows;
    }

    function stripCodexWelcomeBoxLine(line: string) {
      return line
        .trim()
        .replace(/^[│|]\s*/, "")
        .replace(/\s*[│|]$/, "")
        .replace(/^>_\s*/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    function extractCodexWelcomeRows(rows: ConversationLine[]) {
      const lines = rows.map((row) => stripCodexWelcomeBoxLine(row.text)).filter(Boolean);
      if (!lines.some((line) => /\bOpenAI Codex\b/i.test(line))) return [];

      const titleLine = lines.find((line) => /\bOpenAI Codex\b/i.test(line));
      const titleMatch = titleLine?.match(/\bOpenAI Codex\s*(\([^)]*\))?/i);
      const title = titleMatch ? `OpenAI Codex ${titleMatch[1] ?? ""}`.trim() : "OpenAI Codex";
      const model = lines
        .find((line) => /^model:/i.test(line))
        ?.replace(/^model:\s*/i, "")
        .replace(/\s+\/model\b.*$/i, "")
        .trim();
      const directory = lines
        .find((line) => /^directory:/i.test(line))
        ?.replace(/^directory:\s*/i, "")
        .trim();
      const permissions = lines
        .find((line) => /^permissions:/i.test(line))
        ?.replace(/^permissions:\s*/i, "")
        .trim();
      const tipIndex = lines.findIndex((line) => /^Tip:?\b/i.test(line));
      const tip =
        tipIndex >= 0
          ? lines[tipIndex].replace(/^Tip:?\s*/i, "").trim() || lines[tipIndex + 1]?.replace(/^[›>]\s*/, "").trim()
          : "";
      const welcomeRows: ConversationLine[] = [{ text: title }];

      if (model) welcomeRows.push({ text: `model: ${model}`, muted: true });
      if (directory) welcomeRows.push({ text: `directory: ${directory}`, muted: true });
      if (permissions) welcomeRows.push({ text: `permissions: ${permissions}`, muted: true });
      if (tip) welcomeRows.push({ text: `Tip: ${tip}`, muted: true });

      return welcomeRows;
    }

    function upsertCodexWelcomeMessage(rows: ConversationLine[]) {
      const welcomeRows = extractCodexWelcomeRows(rows);
      const welcomeText = buildTextFromRows(welcomeRows);
      if (!welcomeText.trim()) return false;

      const now = Date.now();
      const messageId = codexWelcomeMessageIdRef.current ?? createConversationId();
      codexWelcomeMessageIdRef.current = messageId;

      setConversationMessages((current) => {
        const existingIndex = current.findIndex((message) => message.id === messageId);
        if (existingIndex >= 0) {
          const existing = current[existingIndex];
          if (existing.text === welcomeText && areConversationLinesEqual(existing.lines, welcomeRows)) {
            return current;
          }

          const nextMessages = [...current];
          nextMessages[existingIndex] = {
            ...existing,
            text: welcomeText,
            lines: welcomeRows,
            updatedAt: now,
          };
          return nextMessages;
        }

        const nextMessage: ConversationMessage = {
          id: messageId,
          role: "terminal",
          kind: "tui",
          text: welcomeText,
          lines: welcomeRows,
          createdAt: now,
          updatedAt: now,
        };

        return [...current, nextMessage].slice(-maxConversationMessages);
      });

      return true;
    }

    function countLeadingWhitespaceColumns(text: string) {
      let columns = 0;

      for (const character of text) {
        if (character === " ") {
          columns += 1;
        } else if (character === "\t") {
          columns += 4;
        } else {
          break;
        }
      }

      return columns;
    }

    function stripLeadingWhitespaceColumns(text: string, columns: number) {
      let remainingColumns = columns;
      let index = 0;

      while (index < text.length && remainingColumns > 0) {
        const character = text[index];
        if (character === " ") {
          remainingColumns -= 1;
          index += 1;
        } else if (character === "\t") {
          remainingColumns -= 4;
          index += 1;
        } else {
          break;
        }
      }

      return text.slice(index);
    }

    function isTuiStatusRow(row: ConversationLine) {
      return Boolean(getCodexStatusWord(row.text) ?? getCodexStatusFragmentWord(row.text));
    }

    function getTuiContentRowIndexes(rows: ConversationLine[]) {
      return rows.flatMap((row, index) => (row.text.trim() && !isTuiStatusRow(row) ? [index] : []));
    }

    function looksLikeIntentionalLeadingIndent(text: string, hasFollowingContent: boolean) {
      const trimmedText = text.trimStart();
      if (!trimmedText) return false;

      if (/^(?:[-*+]\s|\d+[.)]\s|>\s|\|)/.test(trimmedText)) return true;
      if (/^[}\])]/.test(trimmedText)) return true;

      return (
        !hasFollowingContent &&
        /^(?:const|let|var|function|class|import|export|return|if|else|for|while|switch|case|try|catch|finally|def|from|SELECT|UPDATE|INSERT|DELETE|CREATE)\b/i.test(
          trimmedText,
        )
      );
    }

    function normalizeTuiDialogIndentation(rows: ConversationLine[]) {
      const contentRowIndexes = getTuiContentRowIndexes(rows);
      if (contentRowIndexes.length === 0) return rows;

      let nextRows = rows;
      const commonIndent = Math.min(
        ...contentRowIndexes.map((index) => countLeadingWhitespaceColumns(nextRows[index].text)),
      );

      if (commonIndent > 0 && Number.isFinite(commonIndent)) {
        nextRows = nextRows.map((row, index) =>
          contentRowIndexes.includes(index)
            ? { ...row, text: stripLeadingWhitespaceColumns(row.text, commonIndent) }
            : row,
        );
      }

      const firstContentIndex = contentRowIndexes[0];
      const firstContentRow = nextRows[firstContentIndex];
      const firstLineIndent = countLeadingWhitespaceColumns(firstContentRow.text);
      if (
        firstLineIndent > 0 &&
        firstLineIndent <= 6 &&
        !looksLikeIntentionalLeadingIndent(firstContentRow.text, contentRowIndexes.length > 1)
      ) {
        const adjustedRows = [...nextRows];
        adjustedRows[firstContentIndex] = { ...firstContentRow, text: firstContentRow.text.trimStart() };
        return adjustedRows;
      }

      return nextRows;
    }

    function truncateConversationRows(rows: ConversationLine[]) {
      let remainingChars = maxLiveTuiSnapshotChars;
      const truncatedRows: ConversationLine[] = [];

      for (const row of rows) {
        const separatorLength = truncatedRows.length > 0 ? 1 : 0;
        const availableChars = remainingChars - separatorLength;
        if (availableChars <= 0) break;

        if (row.text.length <= availableChars) {
          truncatedRows.push(row);
          remainingChars -= row.text.length + separatorLength;
          continue;
        }

        const truncatedText = row.text.slice(0, availableChars).trimEnd();
        if (truncatedText) {
          truncatedRows.push({ ...row, text: truncatedText });
        }
        break;
      }

      const text = truncatedRows.map((row) => row.text).join("\n");
      if (text.length <= maxLiveTuiSnapshotChars) return truncatedRows;

      return truncatedRows;
    }

    function truncateLiveTuiTranscriptRows(rows: ConversationLine[]) {
      let remainingChars = maxLiveTuiTranscriptChars;
      const truncatedRows: ConversationLine[] = [];

      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const separatorLength = truncatedRows.length > 0 ? 1 : 0;
        const availableChars = remainingChars - separatorLength;
        if (availableChars <= 0) break;

        if (row.text.length <= availableChars) {
          truncatedRows.unshift(row);
          remainingChars -= row.text.length + separatorLength;
          continue;
        }

        const truncatedText = row.text.slice(-availableChars).trimStart();
        if (truncatedText) {
          truncatedRows.unshift({ ...row, text: truncatedText });
        }
        break;
      }

      return truncatedRows;
    }

    function buildTextFromRows(rows: ConversationLine[]) {
      return rows.map((row) => row.text).join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();
    }

    function truncateConversationText(text: string) {
      if (text.length <= maxConversationMessageChars) return text;

      const tail = text.slice(-maxConversationMessageChars).trimStart();
      return `... 已省略前面的长输出 ...\n${tail}`;
    }

    function splitTuiConversationRows(rows: ConversationLine[]) {
      const groups: Array<{ role: ConversationRole; lines: ConversationLine[] }> = [];

      for (const row of rows) {
        const role: ConversationRole = row.role === "user" ? "user" : "terminal";
        const lastGroup = groups[groups.length - 1];
        const groupRow = row.role ? { ...row, role: undefined } : row;

        if (lastGroup?.role === role) {
          lastGroup.lines.push(groupRow);
        } else {
          groups.push({ role, lines: [groupRow] });
        }
      }

      return groups
        .map((group) => ({
          ...group,
          lines: trimConversationRows(compactConversationRows(group.lines)),
        }))
        .filter((group) => buildTextFromRows(group.lines).trim());
    }

    function normalizeTranscriptComparison(row: ConversationLine) {
      return `${row.role ?? "terminal"}:${normalizeEchoComparison(row.text)}`;
    }

    function removeSnapshotPrefixAlreadyInTranscript(
      previousRows: ConversationLine[],
      nextRows: ConversationLine[],
      previousNormalized: string[],
      nextNormalized: string[],
    ) {
      const normalizedNextRows = trimConversationRows(nextRows);
      const nonEmptyNextRows = nextNormalized.filter(Boolean).length;
      if (nonEmptyNextRows === 0 || previousRows.length === 0) return null;

      const searchStart = Math.max(0, previousRows.length - nextRows.length - 12);
      let bestStart = -1;
      let bestPrefixLength = 0;
      let bestMatches = 0;

      for (let start = previousRows.length - 1; start >= searchStart; start -= 1) {
        const comparableRows = Math.min(nextRows.length, previousRows.length - start);
        let matches = 0;
        let prefixLength = 0;

        for (let index = 0; index < comparableRows; index += 1) {
          const previousLine = previousNormalized[start + index];
          const nextLine = nextNormalized[index];
          if (!previousLine && !nextLine) {
            prefixLength = index + 1;
            continue;
          }
          if (previousLine !== nextLine) {
            break;
          }

          matches += 1;
          prefixLength = index + 1;
        }

        if (matches > bestMatches || (matches === bestMatches && prefixLength > bestPrefixLength)) {
          bestStart = start;
          bestMatches = matches;
          bestPrefixLength = prefixLength;
        }
      }

      const minimumMatches = Math.min(2, nonEmptyNextRows);
      if (bestStart >= 0 && bestMatches >= minimumMatches && bestPrefixLength < normalizedNextRows.length) {
        return truncateLiveTuiTranscriptRows([...previousRows, ...normalizedNextRows.slice(bestPrefixLength)]);
      }

      return null;
    }

    function replaceMatchingTranscriptTail(
      previousRows: ConversationLine[],
      nextRows: ConversationLine[],
      previousNormalized: string[],
      nextNormalized: string[],
    ) {
      const nonEmptyNextRows = nextNormalized.filter(Boolean).length;
      if (nonEmptyNextRows === 0) return null;

      const minimumMatches = Math.min(2, nonEmptyNextRows);
      const searchStart = Math.max(0, previousRows.length - nextRows.length - 6);
      let bestStart = -1;
      let bestMatches = 0;

      for (let start = previousRows.length - 1; start >= searchStart; start -= 1) {
        let matches = 0;
        const comparableRows = Math.min(nextRows.length, previousRows.length - start);
        for (let index = 0; index < comparableRows; index += 1) {
          const previousLine = previousNormalized[start + index];
          const nextLine = nextNormalized[index];
          if (previousLine && previousLine === nextLine) {
            matches += 1;
          }
        }

        if (matches > bestMatches) {
          bestStart = start;
          bestMatches = matches;
        }
      }

      const matchedRatio = bestMatches / Math.max(1, Math.min(nonEmptyNextRows, nextRows.length));
      if (bestStart >= 0 && bestMatches >= minimumMatches && matchedRatio >= 0.45) {
        return truncateLiveTuiTranscriptRows([...previousRows.slice(0, bestStart), ...nextRows]);
      }

      return null;
    }

    function mergeTuiTranscriptRows(previousRows: ConversationLine[], nextRows: ConversationLine[]) {
      const normalizedNextRows = trimConversationRows(nextRows);
      if (normalizedNextRows.length === 0) return previousRows;
      if (previousRows.length === 0) return truncateLiveTuiTranscriptRows(normalizedNextRows);

      const previousNormalized = previousRows.map(normalizeTranscriptComparison);
      const nextNormalized = normalizedNextRows.map(normalizeTranscriptComparison);
      const maxOverlap = Math.min(previousRows.length, normalizedNextRows.length);

      const dedupedRows = removeSnapshotPrefixAlreadyInTranscript(
        previousRows,
        normalizedNextRows,
        previousNormalized,
        nextNormalized,
      );
      if (dedupedRows) return dedupedRows;

      for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        let matches = true;
        let hasTextMatch = false;
        for (let index = 0; index < overlap; index += 1) {
          const previousLine = previousNormalized[previousRows.length - overlap + index];
          const nextLine = nextNormalized[index];
          if (previousLine !== nextLine) {
            matches = false;
            break;
          }
          if (previousLine || nextLine) {
            hasTextMatch = true;
          }
        }

        if (matches && hasTextMatch) {
          return truncateLiveTuiTranscriptRows([...previousRows, ...normalizedNextRows.slice(overlap)]);
        }
      }

      const replacedRows = replaceMatchingTranscriptTail(
        previousRows,
        normalizedNextRows,
        previousNormalized,
        nextNormalized,
      );
      if (replacedRows) return replacedRows;

      return truncateLiveTuiTranscriptRows([...previousRows, ...normalizedNextRows]);
    }

    function normalizeSnapshotRows(rawRows: ConversationLine[]) {
      return formatTerminalSnapshotRows(rawRows);
    }

    function areConversationLinesEqual(first?: ConversationLine[], second?: ConversationLine[]) {
      if (!first || !second || first.length !== second.length) return false;

      return first.every(
        (line, index) =>
          line.text === second[index].text &&
          Boolean(line.muted) === Boolean(second[index].muted) &&
          line.role === second[index].role,
      );
    }

    function isMutedTerminalCell(cell: TerminalBufferCellSnapshot) {
      if (cell.isDim()) return true;
      if (cell.isFgPalette()) {
        const color = cell.getFgColor();
        return [8, 240, 241, 242, 243, 244, 245].includes(color);
      }
      if (cell.isFgRGB()) {
        const color = cell.getFgColor();
        const red = (color >> 16) & 0xff;
        const green = (color >> 8) & 0xff;
        const blue = color & 0xff;
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        return max - min <= 18 && max >= 72 && max <= 188;
      }

      return false;
    }

    function getStyledBufferLine(line: TerminalBufferLineSnapshot, columns: number): ConversationLine {
      const maxColumns = Math.min(line.length, columns);
      let text = "";
      let lastTextIndex = 0;
      let visibleCellCount = 0;
      let mutedCellCount = 0;

      for (let column = 0; column < maxColumns; column += 1) {
        const cell = line.getCell(column);
        if (cell?.getWidth() === 0) continue;

        const chars = cell?.getChars() ?? "";
        text += chars || " ";

        if (chars) {
          visibleCellCount += 1;
          lastTextIndex = text.length;
          if (cell && isMutedTerminalCell(cell)) {
            mutedCellCount += 1;
          }
        }
      }

      const trimmedText = text.slice(0, lastTextIndex);
      const muted = visibleCellCount > 0 && mutedCellCount / visibleCellCount >= 0.55;
      return muted ? { text: trimmedText, muted: true } : { text: trimmedText };
    }

    function formatTerminalSnapshotRows(rawRows: ConversationLine[]) {
      const rawSummary = summarizeDebugRows(rawRows);
      const recentUserInputs = new Set(recentUserInputsRef.current.map((input) => input.trim()).filter(Boolean));
      let rows = rawRows
        .map((row) => ({
          ...row,
          text: row.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""),
        }))
        .map(stripPromptPrefixForSnapshotRow);
      const shouldCleanCodexChrome = hasCodexTuiChrome(rows.map((row) => row.text));
      const currentPromptRowIndexes = shouldCleanCodexChrome
        ? getCodexCurrentPromptRowIndexes(rows.map((row) => row.text))
        : new Set<number>();

      rows = rows
        .map((row, index) => {
          if (currentPromptRowIndexes.has(index)) {
            return { ...row, role: undefined, text: "" };
          }

          return {
            ...row,
            role:
              shouldCleanCodexChrome && getCodexHistoricalUserLineText(row.text) !== null
                ? ("user" as const)
                : row.role,
            text: cleanCodexTuiChromeLine(row.text, shouldCleanCodexChrome),
          };
        })
        .filter((row) => {
          const trimmedLine = row.text.trim();
          return (
            !trimmedLine ||
            (!recentUserInputs.has(trimmedLine) &&
              (getCodexStatusFragmentWord(trimmedLine) ||
                !isRecentInputSnapshotEchoFragment(row.text, shouldCleanCodexChrome)))
          );
        });

      const droppedEchoPrefixLines = dropWrappedEchoPrefix(rows.map((row) => row.text));
      if (droppedEchoPrefixLines.length !== rows.length) {
        rows = rows.slice(rows.length - droppedEchoPrefixLines.length);
      }

      const cleanedLines = cleanCodexSnapshotLines(
        rows.map((row) => row.text),
        shouldCleanCodexChrome,
      );
      if (cleanedLines.length !== rows.length || cleanedLines.some((line, index) => line !== rows[index]?.text)) {
        const nextRows: ConversationLine[] = [];
        let searchIndex = 0;

        for (const cleanedLine of cleanedLines) {
          const foundIndex = rows.findIndex((row, index) => index >= searchIndex && row.text === cleanedLine);
          if (foundIndex >= 0) {
            nextRows.push(rows[foundIndex]);
            searchIndex = foundIndex + 1;
          } else {
            const statusIndex = rows.findIndex(
              (row, index) =>
                index >= searchIndex &&
                (getCodexStatusWord(row.text) ?? getCodexStatusFragmentWord(row.text)) === cleanedLine,
            );
            if (statusIndex >= 0) {
              nextRows.push({ ...rows[statusIndex], text: cleanedLine });
              searchIndex = statusIndex + 1;
            } else {
              nextRows.push({ text: cleanedLine });
            }
          }
        }

        rows = nextRows;
      }

      rows = compactConversationRows(normalizeTuiDialogIndentation(trimConversationRows(rows)));
      const cleanedSummary = summarizeDebugRows(rows);
      const snapshotSignature = JSON.stringify({
        raw: rawSummary,
        cleaned: cleanedSummary,
        shouldCleanCodexChrome,
        currentPromptRows: currentPromptRowIndexes.size,
      });
      if (snapshotSignature !== lastSnapshotDebugSignatureRef.current) {
        lastSnapshotDebugSignatureRef.current = snapshotSignature;
        writeTuiDebugLog("snapshot-normalized", {
          shouldCleanCodexChrome,
          currentPromptRows: currentPromptRowIndexes.size,
          raw: rawSummary,
          cleaned: cleanedSummary,
        });
      }
      const text = buildTextFromRows(rows);
      if (text.length <= maxLiveTuiSnapshotChars) return rows;

      return [...truncateConversationRows(rows), { text: "...", muted: true }];
    }

    function formatTerminalSnapshotText(value: string) {
      const rows = normalizeSnapshotRows(value.split("\n").map((text) => ({ text })));
      const text = buildTextFromRows(rows);
      if (text.length <= maxLiveTuiSnapshotChars) return text;

      return `${text.slice(0, maxLiveTuiSnapshotChars).trimEnd()}\n...`;
    }

    function getTerminalScreenRows() {
      const terminal = terminalRef.current;
      if (!terminal) return [];

      const buffer = terminal.buffer.active;
      const visibleRows = Math.max(terminal.rows || 24, 1);
      const viewportStart = Math.max(0, Math.min(buffer.baseY, buffer.length - visibleRows));
      const snapshotStart =
        buffer.type === "alternate"
          ? 0
          : Math.max(viewportStart, liveTuiSnapshotStartRowRef.current ?? viewportStart);
      const start = Math.min(snapshotStart, Math.max(buffer.length - 1, 0));
      const end = Math.min(buffer.length, start + visibleRows);
      const rows: ConversationLine[] = [];

      for (let row = start; row < end; row += 1) {
        const line = buffer.getLine(row);
        if (line) {
          rows.push(getStyledBufferLine(line, terminal.cols || line.length));
        }
      }

      const screenText = buildTextFromRows(rows);
      updateTuiContextUsageFromText(screenText);
      logCursorDebug("screen-rows-read");
      return rows;
    }

    function clearLiveTuiSnapshotTimer() {
      if (!liveTuiSnapshotTimerRef.current) return;

      window.clearTimeout(liveTuiSnapshotTimerRef.current);
      liveTuiSnapshotTimerRef.current = null;
    }

    function resetLiveTuiSnapshotState() {
      clearLiveTuiSnapshotTimer();
      liveTuiMessageIdRef.current = null;
      liveTuiOutputQueuedRef.current = false;
      liveTuiSnapshotStartRowRef.current = null;
      liveTuiTranscriptRowsRef.current = [];
      clearTerminalImeStabilizeHold();
    }

    function clearPendingSubmitTimer() {
      if (!pendingSubmitTimerRef.current) return;

      window.clearTimeout(pendingSubmitTimerRef.current);
      pendingSubmitTimerRef.current = null;
    }

    function markLiveTuiSnapshotStart() {
      if (liveTuiSnapshotStartRowRef.current !== null) return;

      const terminal = terminalRef.current;
      if (!terminal) return;

      const buffer = terminal.buffer.active;
      liveTuiSnapshotStartRowRef.current =
        buffer.type === "alternate" ? 0 : Math.max(0, Math.min(buffer.baseY + buffer.cursorY, buffer.length - 1));
      syncTerminalTuiImeStableClass();
    }

    function upsertLiveTuiMessage(rows: ConversationLine[]) {
      const hasCodexWelcome = upsertCodexWelcomeMessage(rows);
      if (!dialogConversationStartedRef.current && !hasCodexWelcome) {
        writeTuiDebugLog("live-tui-skip-before-conversation", {
          hasCodexWelcome,
          rows: summarizeDebugRows(rows),
        });
        return;
      }

      const normalizedRows = normalizeSnapshotRows(rows);
      if (normalizedRows.length === 0) {
        writeTuiDebugLog("live-tui-skip-empty-normalized", {
          raw: summarizeDebugRows(rows),
          normalized: summarizeDebugRows(normalizedRows),
        });
        return;
      }

      const nextTranscriptRows = compactConversationRows(
        mergeTuiTranscriptRows(liveTuiTranscriptRowsRef.current, normalizedRows),
      );
      const nextTranscriptText = buildTextFromRows(nextTranscriptRows);
      if (!nextTranscriptText.trim()) {
        writeTuiDebugLog("live-tui-skip-empty-normalized", {
          raw: summarizeDebugRows(rows),
          normalized: summarizeDebugRows(normalizedRows),
        });
        return;
      }

      liveTuiTranscriptRowsRef.current = nextTranscriptRows;
      writeTuiDebugLog("live-tui-upsert", {
        raw: summarizeDebugRows(rows),
        normalized: summarizeDebugRows(normalizedRows),
        transcript: summarizeDebugRows(nextTranscriptRows),
      });

      const now = Date.now();
      const messageId = liveTuiMessageIdRef.current ?? createConversationId();
      liveTuiMessageIdRef.current = messageId;
      const messageGroups = splitTuiConversationRows(nextTranscriptRows);

      setConversationMessages((current) => {
        const firstExistingIndex = current.findIndex((message) => message.tuiGroupId === messageId);
        const nextGroupedMessages: ConversationMessage[] = messageGroups.map((group, index) => {
          const existing = current.find(
            (message) => message.tuiGroupId === messageId && message.id === `${messageId}-${index}`,
          );
          const text = buildTextFromRows(group.lines);

          return {
            id: `${messageId}-${index}`,
            role: group.role,
            kind: group.role === "user" ? "normal" : "tui",
            text,
            lines: group.lines,
            tuiGroupId: messageId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
        });

        if (firstExistingIndex >= 0) {
          const nextMessages = current.filter((message) => message.tuiGroupId !== messageId);
          nextMessages.splice(firstExistingIndex, 0, ...nextGroupedMessages);
          return nextMessages.slice(-maxConversationMessages);
        }

        return [...current, ...nextGroupedMessages].slice(-maxConversationMessages);
      });
    }

    function captureLiveTuiSnapshot() {
      const snapshotRows = getTerminalScreenRows();
      if (buildTextFromRows(snapshotRows).trim()) {
        writeTuiDebugLog("snapshot-capture", {
          rows: summarizeDebugRows(snapshotRows),
        });
        upsertLiveTuiMessage(snapshotRows);
      } else {
        writeTuiDebugLog("snapshot-capture-empty");
      }
    }

    function hasLiveTuiSnapshotContext() {
      const terminal = terminalRef.current;
      return (
        terminal?.buffer.active.type === "alternate" ||
        liveTuiMessageIdRef.current !== null ||
        liveTuiSnapshotStartRowRef.current !== null ||
        liveTuiOutputQueuedRef.current
      );
    }

    function shouldStabilizeTerminalTuiIme() {
      return (
        viewModeRef.current === "terminal" &&
        hasLiveTuiSnapshotContext() &&
        (terminalImeCompositionActiveRef.current || terminalImeStabilizeHoldRef.current)
      );
    }

    function syncTerminalTuiImeStableClass() {
      const stable = shouldStabilizeTerminalTuiIme();
      if (stable === terminalTuiImeStableRef.current) return;

      terminalTuiImeStableRef.current = stable;
      hostRef.current?.classList.toggle("terminal-tui-ime-stable", stable);
      writeTuiDebugLog("terminal-tui-ime-stable-change", { stable });
    }

    function clearTerminalImeStabilizeHold() {
      if (terminalImeStabilizeHoldTimerRef.current) {
        window.clearTimeout(terminalImeStabilizeHoldTimerRef.current);
        terminalImeStabilizeHoldTimerRef.current = null;
      }
      terminalImeStabilizeHoldRef.current = false;
      syncTerminalTuiImeStableClass();
    }

    function resetTerminalTuiImeStabilization() {
      if (terminalImeStabilizeHoldTimerRef.current) {
        window.clearTimeout(terminalImeStabilizeHoldTimerRef.current);
        terminalImeStabilizeHoldTimerRef.current = null;
      }
      terminalImeCompositionActiveRef.current = false;
      terminalImeStabilizeHoldRef.current = false;
      terminalTuiImeStableRef.current = false;
      hostRef.current?.classList.remove("terminal-tui-ime-stable");
    }

    function scheduleTerminalImeStabilizeHold() {
      terminalImeStabilizeHoldRef.current = true;
      syncTerminalTuiImeStableClass();

      if (terminalImeStabilizeHoldTimerRef.current) {
        window.clearTimeout(terminalImeStabilizeHoldTimerRef.current);
      }
      terminalImeStabilizeHoldTimerRef.current = window.setTimeout(() => {
        terminalImeStabilizeHoldTimerRef.current = null;
        terminalImeStabilizeHoldRef.current = false;
        syncTerminalTuiImeStableClass();
      }, terminalTuiImeStabilizeHoldMs);
    }

    function setTerminalImeCompositionActive(active: boolean) {
      if (terminalImeCompositionActiveRef.current === active) {
        syncTerminalTuiImeStableClass();
        return;
      }

      terminalImeCompositionActiveRef.current = active;
      writeTuiDebugLog(active ? "terminal-ime-composition-start" : "terminal-ime-composition-end");
      if (!active) {
        scheduleTerminalImeStabilizeHold();
      } else {
        syncTerminalTuiImeStableClass();
      }
    }

    function hasNonAsciiInput(data: string) {
      return /[^\x00-\x7f]/.test(data);
    }

    function stabilizeTerminalTuiImeForInput(data: string) {
      syncTerminalTuiImeStableClass();
      if (hasNonAsciiInput(data)) {
        scheduleTerminalImeStabilizeHold();
      }
    }

    function scheduleLiveTuiSnapshot() {
      clearLiveTuiSnapshotTimer();
      liveTuiSnapshotTimerRef.current = window.setTimeout(() => {
        liveTuiSnapshotTimerRef.current = null;
        captureLiveTuiSnapshot();
      }, liveTuiSnapshotDebounceMs);
    }

    function blurTerminalInput() {
      terminalRef.current?.textarea?.blur();
    }

    function showDialogView() {
      resetTerminalTouchScroll();
      setViewMode("dialog");
      viewModeRef.current = "dialog";
      rememberTerminalViewMode("dialog");
      syncTerminalTuiImeStableClass();
      blurTerminalInput();
      writeTuiDebugLog("view-mode-dialog");
      window.setTimeout(() => {
        blurTerminalInput();
        logFocusDebug("view-mode-dialog-after-blur");
        scheduleFitAndResize({ force: true, settle: true });
        if (hasLiveTuiSnapshotContext()) {
          captureLiveTuiSnapshot();
        }
      }, 0);
    }

    function showTerminalView() {
      resetTerminalTouchScroll();
      setViewMode("terminal");
      viewModeRef.current = "terminal";
      rememberTerminalViewMode("terminal");
      syncTerminalTuiImeStableClass();
      writeTuiDebugLog("view-mode-terminal");
      window.setTimeout(() => {
        scheduleFitAndResize({ force: true, settle: true });
        terminalRef.current?.focus();
        logFocusDebug("view-mode-terminal-after-focus");
      }, 0);
    }

    function rememberTerminalViewMode(nextViewMode: TerminalViewMode) {
      try {
        localStorage.setItem(terminalViewModeStorageKey, nextViewMode);
      } catch {
        // Ignore storage failures; the active view still changes for this session.
      }
    }

    function getTerminalLinePixelHeight() {
      return Math.max(8, appearance.fontSize * appearance.lineHeight);
    }

    function resetTerminalTouchScroll() {
      terminalTouchScrollRef.current = null;
    }

    function handleTerminalTouchStart(event: TouchEvent) {
      if (viewModeRef.current !== "terminal") return;
      if (event.touches.length !== 1) {
        resetTerminalTouchScroll();
        return;
      }

      const touch = event.touches[0];
      terminalTouchScrollRef.current = {
        touchId: touch.identifier,
        lastClientY: touch.clientY,
        accumulatedDelta: 0,
      };
    }

    function handleTerminalTouchMove(event: TouchEvent) {
      if (viewModeRef.current !== "terminal") return;

      const scroll = terminalTouchScrollRef.current;
      const terminal = terminalRef.current;
      if (!scroll || !terminal) return;

      const touch = Array.from(event.touches).find((item) => item.identifier === scroll.touchId);
      if (!touch) return;

      const deltaY = scroll.lastClientY - touch.clientY;
      scroll.lastClientY = touch.clientY;
      scroll.accumulatedDelta += deltaY;
      if (event.cancelable) {
        event.preventDefault();
      }

      const lineHeight = getTerminalLinePixelHeight();
      const lines = Math.trunc(scroll.accumulatedDelta / lineHeight);
      if (lines === 0) return;

      terminal.scrollLines(lines);
      scroll.accumulatedDelta -= lines * lineHeight;
    }

    function handleTerminalTouchEnd(event: TouchEvent) {
      const scroll = terminalTouchScrollRef.current;
      if (!scroll) return;

      const stillActive = Array.from(event.touches).some((touch) => touch.identifier === scroll.touchId);
      if (!stillActive) {
        resetTerminalTouchScroll();
      }
    }

    function consumePendingEchoLine(line: string) {
      const normalizedLine = line.trim();
      if (!normalizedLine) return false;

      for (const [index, pendingInput] of pendingEchoInputsRef.current.entries()) {
        if (pendingInput === normalizedLine) {
          pendingEchoInputsRef.current.splice(index, 1);
          return true;
        }

        if (pendingInput.startsWith(normalizedLine)) {
          pendingEchoInputsRef.current[index] = pendingInput.slice(normalizedLine.length).trimStart();
          return true;
        }
      }

      return false;
    }

    function rememberUserConversationInput(text: string) {
      const normalizedText = normalizeInput(text).trim();
      if (!normalizedText) return;

      dialogConversationStartedRef.current = true;
      recentUserInputsRef.current = [...recentUserInputsRef.current, normalizedText].slice(-12);
      pendingEchoInputsRef.current = [...pendingEchoInputsRef.current, normalizedText].slice(-6);
    }

    function appendConversationMessage(role: ConversationRole, text: string) {
      const normalizedText = role === "terminal" ? formatTerminalConversationText(text) : normalizeInput(text).trimEnd();
      if (!normalizedText.trim()) return;

      if (role === "user") {
        resetLiveTuiSnapshotState();
        rememberUserConversationInput(normalizedText);
      }

      const displayText = role === "terminal" ? truncateConversationText(normalizedText) : normalizedText;
      const now = Date.now();
      setConversationMessages((current) => {
        const last = current[current.length - 1];
        if (
          role === "terminal" &&
          last?.role === "terminal" &&
          (last.kind ?? "normal") !== "tui" &&
          now - last.updatedAt <= conversationOutputMergeWindowMs
        ) {
          const nextText = truncateConversationText(`${last.text}\n${displayText}`.replace(/\n{4,}/g, "\n\n\n"));
          return [
            ...current.slice(0, -1),
            {
              ...last,
              text: nextText,
              lines: undefined,
              updatedAt: now,
            },
          ].slice(-maxConversationMessages);
        }

        const nextMessage: ConversationMessage = {
          id: createConversationId(),
          role,
          kind: "normal",
          text: displayText,
          lines: undefined,
          createdAt: now,
          updatedAt: now,
        };

        return [...current, nextMessage].slice(-maxConversationMessages);
      });
    }

    function clearOutputQueue() {
      outputQueueRef.current = [];
      outputWriterActiveRef.current = false;
      resetLiveTuiSnapshotState();
      if (codexWelcomeMessageIdRef.current) {
        const messageId = codexWelcomeMessageIdRef.current;
        codexWelcomeMessageIdRef.current = null;
        setConversationMessages((current) => current.filter((message) => message.id !== messageId));
      }
      setTuiContextUsage(null);
      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
        outputCursorTimerRef.current = null;
      }
      hostRef.current?.classList.remove("terminal-tui-active");
      resetTerminalTuiImeStabilization();
      setOutputCursorSuppressed(false);
      writeTuiDebugLog("output-queue-clear");
    }

    function discardQueuedOutput() {
      outputQueueRef.current = [];
      outputWriterActiveRef.current = false;
      liveTuiOutputQueuedRef.current = false;
      clearLiveTuiSnapshotTimer();
      revealCursorForInput();
      writeTuiDebugLog("output-queue-discard");
    }

    function setOutputCursorSuppressed(suppressed: boolean) {
      outputCursorSuppressedRef.current = suppressed;
      syncCursorSuppressionClass();
      writeTuiDebugLog("cursor-suppressed-change", { suppressed });
    }

    function syncCursorSuppressionClass() {
      hostRef.current?.classList.toggle("terminal-output-streaming", outputCursorSuppressedRef.current);
      syncTerminalTuiImeStableClass();
    }

    function suppressCursorDuringOutput() {
      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
        outputCursorTimerRef.current = null;
      }

      if (!outputCursorSuppressedRef.current) {
        setOutputCursorSuppressed(true);
      }
    }

    function revealCursorAfterOutputSettles(isTuiOutput = false) {
      if (!outputCursorSuppressedRef.current) return;
      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
      }

      writeTuiDebugLog("cursor-reveal-scheduled", { isTuiOutput });
      outputCursorTimerRef.current = window.setTimeout(() => {
        outputCursorTimerRef.current = null;
        if (outputWriterActiveRef.current || outputQueueRef.current.length > 0) return;
        setOutputCursorSuppressed(false);
        logCursorDebug("cursor-revealed-after-output");
      }, isTuiOutput ? tuiOutputCursorRevealDelayMs : outputCursorRevealDelayMs);
    }

    function revealCursorForInput(options: { keepSuppressedForTuiIme?: boolean } = {}) {
      if (options.keepSuppressedForTuiIme) {
        stabilizeTerminalTuiImeForInput("");
        if (shouldStabilizeTerminalTuiIme()) {
          if (outputCursorTimerRef.current) {
            window.clearTimeout(outputCursorTimerRef.current);
            outputCursorTimerRef.current = null;
          }
          if (!outputCursorSuppressedRef.current) {
            setOutputCursorSuppressed(true);
          } else {
            syncCursorSuppressionClass();
          }
          logCursorDebug("cursor-kept-suppressed-for-tui-ime-input");
          return;
        }
      }

      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
        outputCursorTimerRef.current = null;
      }
      setOutputCursorSuppressed(false);
      logCursorDebug("cursor-revealed-for-input");
    }

    function pumpTerminalOutput() {
      const terminal = terminalRef.current;
      const next = outputQueueRef.current.shift();

      if (!terminal || !next) {
        outputWriterActiveRef.current = false;
        writeTuiDebugLog("output-pump-drained", {
          hadTerminal: Boolean(terminal),
          liveTuiOutputQueued: liveTuiOutputQueuedRef.current,
        });
        if (terminal && liveTuiOutputQueuedRef.current) {
          liveTuiOutputQueuedRef.current = false;
          scheduleLiveTuiSnapshot();
        } else {
          liveTuiOutputQueuedRef.current = false;
        }
        revealCursorAfterOutputSettles(hostRef.current?.classList.contains("terminal-tui-active") ?? false);
        return;
      }

      terminal.write(next, () => {
        logCursorDebug("terminal-write-complete");
        if (liveTuiOutputQueuedRef.current) {
          scheduleLiveTuiSnapshot();
        }
        pumpTerminalOutput();
      });
    }

    function enqueueTerminalOutput(data: string) {
      if (!data) return;

      const displayData = mapLightThemeTuiBackgrounds(data, appearance);
      updateTuiContextUsageFromText(displayData);
      const terminal = terminalRef.current;
      const activeAlternateBuffer = terminal?.buffer.active.type === "alternate";
      const isAlternateBufferExitOnly =
        Boolean(activeAlternateBuffer) && hasAlternateBufferDisable(displayData) && !hasSnapshotVisibleText(displayData);
      const useLiveTerminalOutput =
        !isAlternateBufferExitOnly && (shouldUseLiveTerminalOutput(displayData) || activeAlternateBuffer);

      writeTuiDebugLog("terminal-output-enqueue", {
        dataLength: data.length,
        displayLength: displayData.length,
        activeAlternateBuffer,
        isAlternateBufferExitOnly,
        useLiveTerminalOutput,
        preview: safeDebugText(displayData),
      });
      if (useLiveTerminalOutput) {
        markLiveTuiSnapshotStart();
        liveTuiOutputQueuedRef.current = true;
      } else {
        appendConversationMessage("terminal", displayData);
      }
      suppressCursorDuringOutput();
      for (let index = 0; index < displayData.length; index += outputChunkSize) {
        outputQueueRef.current.push(displayData.slice(index, index + outputChunkSize));
      }

      if (!outputWriterActiveRef.current) {
        outputWriterActiveRef.current = true;
        pumpTerminalOutput();
      }
    }

    function writeRawTerminalInput(data: string) {
      const sessionId = sessionIdRef.current;
      if (!sessionId || !data) return;

      stabilizeTerminalTuiImeForInput(data);
      revealCursorForInput({ keepSuppressedForTuiIme: true });
      invoke("terminal_write", {
        sessionId,
        data,
      }).catch(reportTerminalError);
    }

    function normalizeInput(input: string) {
      return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function formatCommandInput(input: string) {
      const normalizedInput = normalizeInput(input).trimEnd();
      if (!normalizedInput) return "";

      return `${normalizedInput.replace(/\n/g, "\r")}\r`;
    }

    function sendRawOrQueueInput(data: string) {
      if (!data) return;

      if (sessionIdRef.current) {
        writeRawTerminalInput(data);
        return;
      }

      pendingRawInputRef.current = `${pendingRawInputRef.current ?? ""}${data}`;
      void startSession();
    }

    function submitRawOrQueueInput(data: string, delayMs = 0) {
      clearPendingSubmitTimer();

      if (sessionIdRef.current) {
        pendingSubmitTimerRef.current = window.setTimeout(() => {
          pendingSubmitTimerRef.current = null;
          writeRawTerminalInput(data);
        }, delayMs);
        return;
      }

      pendingRawInputRef.current = `${pendingRawInputRef.current ?? ""}${data}`;
      void startSession();
    }

    function sendComposerInputToTerminal(input: string) {
      const terminal = terminalRef.current;
      const normalizedInput = normalizeInput(input);
      if (!normalizedInput.trim()) return;

      if (terminal?.modes.bracketedPasteMode) {
        sendRawOrQueueInput(`\x1b[200~${normalizedInput}\x1b[201~`);
        submitRawOrQueueInput("\r", bracketedPasteSubmitDelayMs);
        return;
      }

      const data = normalizedInput.includes("\n")
        ? `${normalizedInput.replace(/\n/g, "\r")}\r`
        : `${normalizedInput}\r`;
      sendRawOrQueueInput(data);
    }

    function markDialogConversationStartedFromTerminalInput(data: string) {
      if (dialogConversationStartedRef.current || !isDirectTerminalConversationInputContext()) return;

      const printableInput = data
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[@-Z\\-_]/g, "")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim();
      if (printableInput || /[\r\n]/.test(data)) {
        dialogConversationStartedRef.current = true;
      }
    }

    function isDirectTerminalConversationInputContext() {
      return hasLiveTuiSnapshotContext() || codexWelcomeMessageIdRef.current !== null;
    }

    function getTerminalInputEscapeSequenceLength(value: string, index: number) {
      if (value[index] !== "\x1b") return 1;

      const next = value[index + 1];
      if (!next) return 1;

      if (next === "[") {
        for (let cursor = index + 2; cursor < value.length; cursor += 1) {
          const code = value.charCodeAt(cursor);
          if (code >= 0x40 && code <= 0x7e) {
            return cursor - index + 1;
          }
        }
        return value.length - index;
      }

      if (next === "O") {
        return Math.min(3, value.length - index);
      }

      return 2;
    }

    function removeLastInputCharacter(value: string) {
      return Array.from(value).slice(0, -1).join("");
    }

    function trackDirectTerminalConversationInput(data: string) {
      if (!isDirectTerminalConversationInputContext()) {
        directTerminalInputDraftRef.current = "";
        directTerminalBracketedPasteRef.current = false;
        return;
      }

      let draft = directTerminalInputDraftRef.current;
      let isBracketedPaste = directTerminalBracketedPasteRef.current;
      const submittedInputs: string[] = [];

      for (let index = 0; index < data.length;) {
        if (data.startsWith("\x1b[200~", index)) {
          isBracketedPaste = true;
          index += "\x1b[200~".length;
          continue;
        }

        if (data.startsWith("\x1b[201~", index)) {
          isBracketedPaste = false;
          index += "\x1b[201~".length;
          continue;
        }

        const character = data[index];
        if (isBracketedPaste) {
          draft += character;
          index += 1;
          continue;
        }

        if (character === "\x1b") {
          index += getTerminalInputEscapeSequenceLength(data, index);
          continue;
        }

        if (character === "\r" || character === "\n") {
          const submittedInput = normalizeInput(draft).trimEnd();
          if (submittedInput.trim()) {
            submittedInputs.push(submittedInput);
          }
          draft = "";
          index += character === "\r" && data[index + 1] === "\n" ? 2 : 1;
          continue;
        }

        if (character === "\x7f" || character === "\b") {
          draft = removeLastInputCharacter(draft);
          index += 1;
          continue;
        }

        if (character === "\x03" || character === "\x04" || character === "\x15" || character === "\x18") {
          draft = "";
          index += 1;
          continue;
        }

        if (character === "\x17") {
          draft = draft.replace(/\S+\s*$/, "");
          index += 1;
          continue;
        }

        if (character >= " " || character > "\x7f") {
          draft += character;
        }

        index += 1;
      }

      directTerminalInputDraftRef.current = draft;
      directTerminalBracketedPasteRef.current = isBracketedPaste;
      submittedInputs.forEach((input) => appendConversationMessage("user", input));
    }

    function isPasteShortcut(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      return (
        event.type === "keydown" &&
        (((event.ctrlKey || event.metaKey) && !event.altKey && key === "v") ||
          (event.shiftKey && !event.ctrlKey && !event.metaKey && key === "insert"))
      );
    }

    async function stopSession() {
      const sessionId = sessionIdRef.current;
      startingSessionIdRef.current = null;
      sessionIdRef.current = null;
      pendingStartSessionRef.current = false;
      pendingRawInputRef.current = null;
      lastResizeRef.current = null;
      lastFitHostSizeRef.current = null;
      directTerminalInputDraftRef.current = "";
      directTerminalBracketedPasteRef.current = false;
      isLifecycleStoppingRef.current = true;
      dialogConversationStartedRef.current = false;
      clearPendingSubmitTimer();
      setSession(null);
      clearOutputQueue();
      if (sessionId) {
        await invoke("terminal_stop", { sessionId }).catch(() => undefined);
      }
    }

    async function flushPendingRawInput(sessionId: string) {
      const data = pendingRawInputRef.current;
      if (!data) return;

      pendingRawInputRef.current = null;
      void sessionId;
      writeRawTerminalInput(data);
    }

    function applyWindowsPtyOptions(started: TerminalStarted) {
      const terminal = terminalRef.current;
      if (!terminal || typeof started.windowsBuildNumber !== "number") return;

      terminal.options.windowsPty = {
        backend: "conpty",
        buildNumber: started.windowsBuildNumber,
      };
    }

    function getTerminalHostSize() {
      const host = hostRef.current;
      if (!host) return null;

      const rect = host.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
      };
    }

    function hasTerminalHostSizeChanged(nextSize: { width: number; height: number } | null) {
      if (!nextSize || nextSize.width <= 0 || nextSize.height <= 0) return false;

      const previousSize = lastFitHostSizeRef.current;
      if (!previousSize) return true;

      return (
        Math.abs(previousSize.width - nextSize.width) >= terminalHostSizeEpsilon ||
        Math.abs(previousSize.height - nextSize.height) >= terminalHostSizeEpsilon
      );
    }

    function fitTerminal(options: { force?: boolean } = {}) {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return null;

      const hostSize = getTerminalHostSize();
      if (!options.force && !hasTerminalHostSizeChanged(hostSize)) {
        return {
          cols: terminal.cols || 100,
          rows: terminal.rows || 28,
        };
      }

      fit.fit();
      lastFitHostSizeRef.current = hostSize;
      return {
        cols: terminal.cols || 100,
        rows: terminal.rows || 28,
      };
    }

    function fitAndResize(options: { force?: boolean } = {}) {
      if (!isVisibleRef.current) return;

      const size = fitTerminal(options);
      const sessionId = sessionIdRef.current;
      if (!size || !sessionId) return;

      const lastResize = lastResizeRef.current;
      if (lastResize && lastResize.cols === size.cols && lastResize.rows === size.rows) {
        return;
      }

      lastResizeRef.current = size;
      invoke("terminal_resize", {
        sessionId,
        cols: size.cols,
        rows: size.rows,
      }).catch(() => undefined);
    }

    function clearScheduledResize() {
      if (resizeTimerRef.current) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (resizeFrameRef.current) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      resizeSettleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      resizeSettleTimersRef.current = [];
    }

    function scheduleFitAndResize(options: { force?: boolean; settle?: boolean } = {}) {
      if (!isVisibleRef.current) return;

      clearScheduledResize();
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        fitAndResize({ force: options.force });

        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          fitAndResize({ force: options.force });
        });

        if (options.force || options.settle) {
          resizeSettleTimersRef.current = resizeSettleDelays.map((delay) =>
            window.setTimeout(() => fitAndResize({ force: options.force }), delay),
          );
        }
      }, resizeDebounceMs);
    }

    async function startSession(options: { restartIfStarting?: boolean } = {}) {
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (isStartingRef.current) {
        if (options.restartIfStarting) {
          pendingStartSessionRef.current = true;
          isLifecycleStoppingRef.current = false;
        }
        return;
      }

      pendingStartSessionRef.current = false;
      isStartingRef.current = true;
      isLifecycleStoppingRef.current = false;
      setIsStarting(true);
      clearOutputQueue();
      lastResizeRef.current = null;
      lastFitHostSizeRef.current = null;
      terminal.reset();
      writeTuiDebugLog("session-start-request");

      try {
        const size = isVisibleRef.current ? fitTerminal({ force: true }) ?? { cols: 100, rows: 28 } : { cols: 100, rows: 28 };
        const sessionId = createClientId();
        const requestedProjectId = activeProjectIdRef.current || null;
        startingSessionIdRef.current = sessionId;
        lastResizeRef.current = size;

        const started = await invoke<TerminalStarted>("terminal_start", {
          sessionId,
          projectId: requestedProjectId,
          cols: size.cols,
          rows: size.rows,
        });
        writeTuiDebugLog("session-started", {
          sessionId: started.sessionId,
          shell: started.shell,
          cwd: started.cwd,
          size,
        });
        const projectChangedWhileStarting = (activeProjectIdRef.current || null) !== requestedProjectId;
        if (
          startingSessionIdRef.current !== started.sessionId ||
          isLifecycleStoppingRef.current ||
          projectChangedWhileStarting
        ) {
          if (startingSessionIdRef.current === started.sessionId) {
            startingSessionIdRef.current = null;
          }
          lastResizeRef.current = null;
          lastFitHostSizeRef.current = null;
          await invoke("terminal_stop", { sessionId: started.sessionId }).catch(() => undefined);
          if (projectChangedWhileStarting && !isLifecycleStoppingRef.current) {
            pendingStartSessionRef.current = true;
          }
          return;
        }

        applyWindowsPtyOptions(started);
        startingSessionIdRef.current = null;
        sessionIdRef.current = started.sessionId;
        setSession(started);
        appendConversationMessage("terminal", `${started.shell}\n${started.cwd}`);
        terminal.clear();
        terminal.writeln(`\x1b[38;5;113m${started.shell}\x1b[0m  \x1b[38;5;245m${started.cwd}\x1b[0m`);
        if (!isTauriRuntime() && started.shell === "Browser preview") {
          terminal.writeln(`\x1b[38;5;245m${browserPreviewMessage}\x1b[0m`);
        }
        scheduleFitAndResize({ force: true, settle: true });
        await flushPendingRawInput(started.sessionId);
      } catch (err) {
        startingSessionIdRef.current = null;
        sessionIdRef.current = null;
        lastResizeRef.current = null;
        lastFitHostSizeRef.current = null;
        const message = String(err);
        writeTuiDebugLog("session-start-error", { message });
        terminal.writeln(`\x1b[31m${message}\x1b[0m`);
        onError(message);
      } finally {
        isStartingRef.current = false;
        setIsStarting(false);
        if (
          pendingStartSessionRef.current &&
          terminalRef.current &&
          !isLifecycleStoppingRef.current
        ) {
          pendingStartSessionRef.current = false;
          void startSession(options);
        }
      }
    }

    async function restartSession() {
      await stopSession();
      await startSession();
    }

    useImperativeHandle(ref, () => ({
      restartSession,
      stopSession,
      focus() {
        if (viewMode === "terminal") {
          terminalRef.current?.focus();
        } else {
          blurTerminalInput();
        }
      },
      fit() {
        scheduleFitAndResize();
      },
      interrupt() {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;

        discardQueuedOutput();
        writeRawTerminalInput("\x03");
      },
      sendRawInput(input: string) {
        sendRawOrQueueInput(input);
      },
      sendComposerInput(input: string) {
        appendConversationMessage("user", input);
        sendComposerInputToTerminal(input);
      },
    }));

    useEffect(() => {
      const log = conversationLogRef.current;
      if (!log) return;

      log.scrollTop = log.scrollHeight;
    }, [conversationMessages]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const handleTouchCancel = () => resetTerminalTouchScroll();
      host.addEventListener("touchstart", handleTerminalTouchStart, { passive: true });
      host.addEventListener("touchmove", handleTerminalTouchMove, { passive: false });
      host.addEventListener("touchend", handleTerminalTouchEnd, { passive: true });
      host.addEventListener("touchcancel", handleTouchCancel, { passive: true });

      return () => {
        host.removeEventListener("touchstart", handleTerminalTouchStart);
        host.removeEventListener("touchmove", handleTerminalTouchMove);
        host.removeEventListener("touchend", handleTerminalTouchEnd);
        host.removeEventListener("touchcancel", handleTouchCancel);
      };
    }, [appearance.fontSize, appearance.lineHeight]);

    useEffect(() => {
      onRuntimeChange(tabId, { session, isStarting });
    }, [isStarting, onRuntimeChange, session, tabId]);

    useEffect(() => {
      isActiveRef.current = isActive;

      if (isActive) {
        scheduleFitAndResize({ force: true, settle: true });
      }
    }, [isActive]);

    useEffect(() => {
      isVisibleRef.current = isVisible;
      if (!isVisible) return;

      scheduleFitAndResize({ force: true, settle: true });
    }, [isVisible]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      void ensureTuiDebugLogReady().then(() => {
        writeTuiDebugLog("debug-log-ready", { path: tuiDebugLogPath });
      });
      setConversationMessages([]);
      const terminal = new XTerm({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorInactiveStyle: "none",
        cursorStyle: "bar",
        cursorWidth: 2,
        fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, "SFMono-Regular", monospace',
        fontSize: appearance.fontSize,
        lineHeight: appearance.lineHeight,
        minimumContrastRatio: 4.5,
        smoothScrollDuration: 0,
        scrollback: 4000,
        theme: getXtermTheme(appearance),
      });
      const fit = new FitAddon();

      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;
      writeTuiDebugLog("xterm-opened", {
        fontSize: appearance.fontSize,
        lineHeight: appearance.lineHeight,
      });
      scheduleFitAndResize({ force: true, settle: true });

      const bufferDisposable = terminal.buffer.onBufferChange((buffer) => {
        const isAlternateBuffer = buffer.type === "alternate";
        host.classList.toggle("terminal-tui-active", isAlternateBuffer);
        syncTerminalTuiImeStableClass();
        writeTuiDebugLog("buffer-change", {
          bufferType: buffer.type,
          isAlternateBuffer,
          cursorX: buffer.cursorX,
          cursorY: buffer.cursorY,
          baseY: buffer.baseY,
        });
        if (!isAlternateBuffer) {
          directTerminalInputDraftRef.current = "";
          directTerminalBracketedPasteRef.current = false;
          resetTerminalTuiImeStabilization();
        }
        if (isAlternateBuffer) {
          liveTuiSnapshotStartRowRef.current = 0;
          liveTuiOutputQueuedRef.current = true;
          scheduleLiveTuiSnapshot();
        }
      });

      const dataDisposable = terminal.onData((data) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        writeTuiDebugLog("xterm-data", {
          length: data.length,
          hasReturn: /[\r\n]/.test(data),
          preview: safeDebugText(data, 80),
        });
        trackDirectTerminalConversationInput(data);
        markDialogConversationStartedFromTerminalInput(data);
        stabilizeTerminalTuiImeForInput(data);
        revealCursorForInput({ keepSuppressedForTuiIme: true });
        invoke("terminal_write", { sessionId, data }).catch(reportTerminalError);
      });

      const compositionStartListener = () => {
        setTerminalImeCompositionActive(true);
      };
      const compositionEndListener = () => {
        setTerminalImeCompositionActive(false);
      };
      terminal.textarea?.addEventListener("compositionstart", compositionStartListener);
      terminal.textarea?.addEventListener("compositionend", compositionEndListener);

      const focusInListener = () => {
        logFocusDebug("focusin");
      };
      const focusOutListener = () => {
        window.setTimeout(() => logFocusDebug("focusout"), 0);
      };
      document.addEventListener("focusin", focusInListener);
      document.addEventListener("focusout", focusOutListener);
      terminal.attachCustomKeyEventHandler((event) => {
        if (isPasteShortcut(event)) return false;
        return true;
      });

      const pasteListener = (event: ClipboardEvent) => {
        const imageItem = getClipboardImageItem(event.clipboardData);
        if (!imageItem) return;

        event.preventDefault();
        event.stopPropagation();
        void saveClipboardImage(imageItem)
          .then((path) => {
            if (path) terminalRef.current?.paste(formatPastedImagePath(path));
          })
          .catch(reportTerminalError);
      };
      host.addEventListener("paste", pasteListener, { capture: true });

      const resizeObserver = new ResizeObserver(() => {
        scheduleFitAndResize();
      });
      const handleViewportResize = () => {
        lastFitHostSizeRef.current = null;
        scheduleFitAndResize({ force: true, settle: true });
      };
      resizeObserver.observe(host);
      window.addEventListener("resize", handleViewportResize);
      document.addEventListener("fullscreenchange", handleViewportResize);
      window.visualViewport?.addEventListener("resize", handleViewportResize);

      const unlistenOutput = listen<TerminalOutput>("terminal-output", (event) => {
        if (event.payload.sessionId === sessionIdRef.current) {
          enqueueTerminalOutput(event.payload.data);
        }
      });

      const unlistenExit = listen<TerminalExit>("terminal-exit", (event) => {
        if (event.payload.sessionId !== sessionIdRef.current) return;
        sessionIdRef.current = null;
        dialogConversationStartedRef.current = false;
        setSession(null);
        appendConversationMessage("terminal", "会话已结束");
      });

      startSession({ restartIfStarting: true });

      return () => {
        clearScheduledResize();
        clearPendingSubmitTimer();
        resizeObserver.disconnect();
        window.removeEventListener("resize", handleViewportResize);
        document.removeEventListener("fullscreenchange", handleViewportResize);
        document.removeEventListener("focusin", focusInListener);
        document.removeEventListener("focusout", focusOutListener);
        window.visualViewport?.removeEventListener("resize", handleViewportResize);
        host.removeEventListener("paste", pasteListener, { capture: true });
        terminal.textarea?.removeEventListener("compositionstart", compositionStartListener);
        terminal.textarea?.removeEventListener("compositionend", compositionEndListener);
        terminal.attachCustomKeyEventHandler(() => true);
        bufferDisposable.dispose();
        dataDisposable.dispose();
        unlistenOutput.then((unlisten) => unlisten());
        unlistenExit.then((unlisten) => unlisten());
        isLifecycleStoppingRef.current = true;
        dialogConversationStartedRef.current = false;
        clearOutputQueue();
        resetTerminalTuiImeStabilization();
        flushTuiDebugLog();
        void stopSession();
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
      };
    }, [activeProjectId]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      terminal.options.theme = getXtermTheme(appearance);
      terminal.options.fontSize = appearance.fontSize;
      terminal.options.lineHeight = appearance.lineHeight;
      lastFitHostSizeRef.current = null;
      scheduleFitAndResize({ force: true, settle: true });
    }, [appearance]);

    useEffect(() => {
      if (!commandRequest || lastCommandIdRef.current === commandRequest.id) return;

      lastCommandIdRef.current = commandRequest.id;
      pendingRawInputRef.current = formatCommandInput(commandRequest.command);
      appendConversationMessage("user", commandRequest.command);

      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void flushPendingRawInput(sessionId);
      } else {
        void startSession();
      }
    }, [commandRequest?.id]);

    function renderConversationText(message: ConversationMessage) {
      if (!message.lines?.length) return message.text;

      return (
        <span className="terminal-dialog-lines">
          {message.lines.map((line, index) => (
            <span
              className={`terminal-dialog-line ${line.muted ? "muted" : ""}`}
              key={`${message.id}-${index}`}
            >
              {line.text || "\u00a0"}
            </span>
          ))}
        </span>
      );
    }

    return (
      <div
        className={`terminal-session ${isVisible ? "visible" : ""} ${isActive ? "active" : ""} ${
          tuiContextUsage ? "has-context" : ""
        } mode-${viewMode}`}
      >
        <div className="terminal-view-switch" role="group" aria-label="显示模式">
          <button
            className={viewMode === "dialog" ? "active" : ""}
            type="button"
            onClick={showDialogView}
          >
            对话
          </button>
          <button
            className={viewMode === "terminal" ? "active" : ""}
            type="button"
            onClick={showTerminalView}
          >
            终端
          </button>
        </div>
        {tuiContextUsage ? (
          <div
            className="terminal-dialog-context"
            aria-label={getTuiContextTitle(tuiContextUsage)}
            title={getTuiContextTitle(tuiContextUsage)}
          >
            <span className="terminal-dialog-context-label">{getTuiContextLabel(tuiContextUsage)}</span>
            <span className="terminal-dialog-context-meter" aria-hidden="true">
              <span style={{ width: `${getTuiContextUsedPercent(tuiContextUsage)}%` }} />
            </span>
          </div>
        ) : null}
        <div className="terminal-dialog-split" aria-hidden={viewMode !== "dialog"}>
          <div
            className="terminal-dialog-log"
            ref={conversationLogRef}
            aria-label="对话记录"
          >
            {conversationMessages
              .filter((message) => viewMode !== "dialog" || message.role === "user" || message.kind === "tui")
              .map((message) => (
                <div className={`terminal-dialog-row ${message.role} ${message.kind ?? "normal"}`} key={message.id}>
                  <div className="terminal-dialog-bubble">{renderConversationText(message)}</div>
                </div>
              ))}
          </div>
        </div>
        <div
          className={`terminal-host ${isVisible ? "visible" : ""} ${isActive ? "active" : ""}`}
          ref={hostRef}
        />
      </div>
    );
  },
);
