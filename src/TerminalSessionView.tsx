import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { formatPastedImagePath, getClipboardImageItem, saveClipboardImage } from "./clipboardImages";
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
const resizeDebounceMs = 40;
const resizeSettleDelays = [80, 180, 360];
const browserPreviewMessage =
  "Browser preview mode: native terminal sessions run only inside the Tauri app.";
const conversationOutputMergeWindowMs = 1200;
const maxConversationMessages = 160;
const liveTuiSnapshotDebounceMs = 80;
const maxLiveTuiSnapshotChars = 6000;
const composerSubmitDelayMs = 0;
const codexStatusWords = ["Working", "Thinking", "Reading", "Editing", "Running"];

type ConversationRole = "user" | "terminal";
type ConversationMessageKind = "normal" | "tui";
type TerminalViewMode = "dialog" | "terminal";

interface ConversationMessage {
  id: string;
  role: ConversationRole;
  kind?: ConversationMessageKind;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface TuiContextUsage {
  percent: number;
  mode: "left" | "used";
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
    const conversationLogRef = useRef<HTMLDivElement | null>(null);
    const startingSessionIdRef = useRef<string | null>(null);
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
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const recentUserInputsRef = useRef<string[]>([]);
    const pendingEchoInputsRef = useRef<string[]>([]);
    const liveTuiMessageIdRef = useRef<string | null>(null);
    const liveTuiSnapshotTimerRef = useRef<number | null>(null);
    const liveTuiOutputQueuedRef = useRef(false);
    const liveTuiSnapshotStartRowRef = useRef<number | null>(null);
    const pendingSubmitTimerRef = useRef<number | null>(null);
    const [session, setSession] = useState<TerminalStarted | null>(null);
    const [isStarting, setIsStarting] = useState(false);
    const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
    const [tuiContextUsage, setTuiContextUsage] = useState<TuiContextUsage | null>(null);
    const [viewMode, setViewMode] = useState<TerminalViewMode>("dialog");

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

    function createConversationId() {
      return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
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

        return usage;
      });
    }

    function getTuiContextUsedPercent(usage: TuiContextUsage) {
      return usage.mode === "used" ? usage.percent : 100 - usage.percent;
    }

    function getTuiContextLabel(usage: TuiContextUsage) {
      const usedPercent = getTuiContextUsedPercent(usage);
      const leftPercent = 100 - usedPercent;
      return `会话占用 ${usedPercent}% / 剩余 ${leftPercent}%`;
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
        /^[•●]?\s*(Working|Thinking|Reading|Editing|Running)\b/i.test(text)
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
          /\besc to interrupt\b/i.test(normalizedLine) ||
          /\bContext\s+\d+%\s+(?:left|used)\b/i.test(normalizedLine) ||
          /\bgpt-[\w.-]+/i.test(normalizedLine) ||
          /[>›]\s*Improve\b/i.test(normalizedLine) ||
          /@filename/i.test(normalizedLine)
        );
      });
    }

    function getCodexStatusWord(line: string) {
      const normalizedLine = normalizeEchoComparison(line.replace(/^[•●?]\s*/, ""));
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
      const normalizedValue = normalizeEchoComparison(value.replace(/[•●·?]/g, " "));
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

    function isCodexTuiNoiseLine(line: string, shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return false;

      const text = line.trim();
      if (!text) return false;
      if (/^[•●·?\s\d]+$/.test(text)) return true;
      if (getCodexStatusFragmentWord(text)) return false;

      return false;
    }

    function cleanCodexTuiChromeLine(line: string, shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return line;

      let text = line.trimEnd();
      text = text.replace(/[>›]\s*Improve.*$/i, "").trimEnd();
      text = text.replace(/\([^)]*\besc to interrupt\b[^)]*\)/gi, "").trimEnd();

      const statusInFooter = text.match(/\b(Working|Thinking|Reading|Editing|Running)\b\s*$/i);
      if (/\bContext\s+\d+%\s+(?:left|used)\b/i.test(text)) {
        return statusInFooter ? statusInFooter[1] : "";
      }

      if (/^\s*>/.test(text)) return "";
      if (/\besc to interrupt\b/i.test(text)) return "";
      if (isCodexTuiNoiseLine(text, shouldCleanCodexChrome)) return "";

      return text;
    }

    function isCodexTuiChromeLine(line: string) {
      const text = normalizeEchoComparison(line);
      if (!text) return false;

      return (
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
      let lastStatusWord: string | null = null;

      for (const line of lines) {
        const statusWord = getCodexStatusWord(line) ?? getCodexStatusFragmentWord(line);
        if (statusWord) {
          lastStatusWord = statusWord;
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

      return contentLines.length > 0 ? contentLines : lastStatusWord ? [lastStatusWord] : [];
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

    function formatTerminalSnapshotText(value: string) {
      const recentUserInputs = new Set(recentUserInputsRef.current.map((input) => input.trim()).filter(Boolean));
      let lines = value
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .split("\n")
        .map(stripPromptPrefixForSnapshot);
      const shouldCleanCodexChrome = hasCodexTuiChrome(lines);

      lines = lines
        .map((line) => cleanCodexTuiChromeLine(line, shouldCleanCodexChrome))
        .filter((line) => {
          const trimmedLine = line.trim();
          return (
            !trimmedLine ||
            (!recentUserInputs.has(trimmedLine) &&
              (getCodexStatusFragmentWord(trimmedLine) ||
                !isRecentInputSnapshotEchoFragment(line, shouldCleanCodexChrome)))
          );
        });

      lines = dropWrappedEchoPrefix(lines);
      lines = cleanCodexSnapshotLines(lines, shouldCleanCodexChrome);

      while (lines.length > 0 && !lines[0].trim()) {
        lines.shift();
      }
      while (lines.length > 0 && !lines[lines.length - 1].trim()) {
        lines.pop();
      }

      const compactLines: string[] = [];
      let blankLineCount = 0;
      for (const line of lines) {
        if (!line.trim()) {
          blankLineCount += 1;
          if (blankLineCount <= 2) {
            compactLines.push("");
          }
          continue;
        }

        blankLineCount = 0;
        compactLines.push(line);
      }

      const text = compactLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();
      if (text.length <= maxLiveTuiSnapshotChars) return text;

      return `${text.slice(0, maxLiveTuiSnapshotChars).trimEnd()}\n...`;
    }

    function getTerminalScreenText() {
      const terminal = terminalRef.current;
      if (!terminal) return "";

      const buffer = terminal.buffer.active;
      const visibleRows = Math.max(terminal.rows || 24, 1);
      const viewportStart = Math.max(0, Math.min(buffer.baseY, buffer.length - visibleRows));
      const snapshotStart =
        buffer.type === "alternate"
          ? 0
          : Math.max(viewportStart, liveTuiSnapshotStartRowRef.current ?? viewportStart);
      const start = Math.min(snapshotStart, Math.max(buffer.length - 1, 0));
      const end = Math.min(buffer.length, start + visibleRows);
      const lines: string[] = [];

      for (let row = start; row < end; row += 1) {
        const line = buffer.getLine(row);
        if (line) {
          lines.push(line.translateToString(true));
        }
      }

      const screenText = lines.join("\n");
      updateTuiContextUsageFromText(screenText);
      return formatTerminalSnapshotText(screenText);
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
    }

    function upsertLiveTuiMessage(text: string) {
      const normalizedText = formatTerminalSnapshotText(text);
      if (!normalizedText.trim()) return;

      const now = Date.now();
      const messageId = liveTuiMessageIdRef.current ?? createConversationId();
      liveTuiMessageIdRef.current = messageId;

      setConversationMessages((current) => {
        const existingIndex = current.findIndex((message) => message.id === messageId);
        if (existingIndex >= 0) {
          const existing = current[existingIndex];
          if (existing.text === normalizedText && existing.kind === "tui") {
            return current;
          }

          const nextMessages = [...current];
          nextMessages[existingIndex] = {
            ...existing,
            kind: "tui",
            text: normalizedText,
            updatedAt: now,
          };
          return nextMessages;
        }

        const nextMessage: ConversationMessage = {
          id: messageId,
          role: "terminal",
          kind: "tui",
          text: normalizedText,
          createdAt: now,
          updatedAt: now,
        };

        return [...current, nextMessage].slice(-maxConversationMessages);
      });
    }

    function captureLiveTuiSnapshot() {
      const snapshot = getTerminalScreenText();
      if (snapshot.trim()) {
        upsertLiveTuiMessage(snapshot);
      }
    }

    function scheduleLiveTuiSnapshot() {
      clearLiveTuiSnapshotTimer();
      liveTuiSnapshotTimerRef.current = window.setTimeout(() => {
        liveTuiSnapshotTimerRef.current = null;
        captureLiveTuiSnapshot();
      }, liveTuiSnapshotDebounceMs);
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

      const now = Date.now();
      setConversationMessages((current) => {
        const last = current[current.length - 1];
        if (
          role === "terminal" &&
          last?.role === "terminal" &&
          (last.kind ?? "normal") !== "tui" &&
          now - last.updatedAt <= conversationOutputMergeWindowMs
        ) {
          return [
            ...current.slice(0, -1),
            {
              ...last,
              text: `${last.text}\n${normalizedText}`.replace(/\n{4,}/g, "\n\n\n"),
              updatedAt: now,
            },
          ].slice(-maxConversationMessages);
        }

        const nextMessage: ConversationMessage = {
          id: createConversationId(),
          role,
          kind: "normal",
          text: normalizedText,
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
      setTuiContextUsage(null);
      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
        outputCursorTimerRef.current = null;
      }
      hostRef.current?.classList.remove("terminal-tui-active");
      setOutputCursorSuppressed(false);
    }

    function discardQueuedOutput() {
      outputQueueRef.current = [];
      outputWriterActiveRef.current = false;
      liveTuiOutputQueuedRef.current = false;
      clearLiveTuiSnapshotTimer();
      revealCursorForInput();
    }

    function setOutputCursorSuppressed(suppressed: boolean) {
      outputCursorSuppressedRef.current = suppressed;
      syncCursorSuppressionClass();
    }

    function syncCursorSuppressionClass() {
      hostRef.current?.classList.toggle("terminal-output-streaming", outputCursorSuppressedRef.current);
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

    function revealCursorAfterOutputSettles() {
      if (!outputCursorSuppressedRef.current) return;
      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
      }

      outputCursorTimerRef.current = window.setTimeout(() => {
        outputCursorTimerRef.current = null;
        if (outputWriterActiveRef.current || outputQueueRef.current.length > 0) return;
        setOutputCursorSuppressed(false);
      }, outputCursorRevealDelayMs);
    }

    function revealCursorForInput() {
      if (outputCursorTimerRef.current) {
        window.clearTimeout(outputCursorTimerRef.current);
        outputCursorTimerRef.current = null;
      }
      setOutputCursorSuppressed(false);
    }

    function pumpTerminalOutput() {
      const terminal = terminalRef.current;
      const next = outputQueueRef.current.shift();

      if (!terminal || !next) {
        outputWriterActiveRef.current = false;
        if (terminal && liveTuiOutputQueuedRef.current) {
          liveTuiOutputQueuedRef.current = false;
          scheduleLiveTuiSnapshot();
        } else {
          liveTuiOutputQueuedRef.current = false;
        }
        revealCursorAfterOutputSettles();
        return;
      }

      terminal.write(next, () => {
        if (liveTuiOutputQueuedRef.current) {
          scheduleLiveTuiSnapshot();
        }
        pumpTerminalOutput();
      });
    }

    function enqueueTerminalOutput(data: string) {
      if (!data) return;

      updateTuiContextUsageFromText(data);
      const terminal = terminalRef.current;
      const activeAlternateBuffer = terminal?.buffer.active.type === "alternate";
      const isAlternateBufferExitOnly =
        Boolean(activeAlternateBuffer) && hasAlternateBufferDisable(data) && !hasSnapshotVisibleText(data);
      const useLiveTerminalOutput =
        !isAlternateBufferExitOnly && (shouldUseLiveTerminalOutput(data) || activeAlternateBuffer);

      if (useLiveTerminalOutput) {
        markLiveTuiSnapshotStart();
        liveTuiOutputQueuedRef.current = true;
      } else {
        appendConversationMessage("terminal", data);
      }
      suppressCursorDuringOutput();
      for (let index = 0; index < data.length; index += outputChunkSize) {
        outputQueueRef.current.push(data.slice(index, index + outputChunkSize));
      }

      if (!outputWriterActiveRef.current) {
        outputWriterActiveRef.current = true;
        pumpTerminalOutput();
      }
    }

    function writeRawTerminalInput(data: string) {
      const sessionId = sessionIdRef.current;
      if (!sessionId || !data) return;

      revealCursorForInput();
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

    function submitRawOrQueueInput(data: string) {
      clearPendingSubmitTimer();

      if (sessionIdRef.current) {
        pendingSubmitTimerRef.current = window.setTimeout(() => {
          pendingSubmitTimerRef.current = null;
          writeRawTerminalInput(data);
        }, composerSubmitDelayMs);
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
        submitRawOrQueueInput("\r");
        return;
      }

      const data = normalizedInput.includes("\n")
        ? `${normalizedInput.replace(/\n/g, "\r")}\r`
        : `${normalizedInput}\r`;
      sendRawOrQueueInput(data);
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
      pendingRawInputRef.current = null;
      lastResizeRef.current = null;
      isLifecycleStoppingRef.current = true;
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

    function fitTerminal() {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return null;

      fit.fit();
      return {
        cols: terminal.cols || 100,
        rows: terminal.rows || 28,
      };
    }

    function fitAndResize() {
      if (!isVisibleRef.current) return;

      const size = fitTerminal();
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

    function scheduleFitAndResize() {
      if (!isVisibleRef.current) return;

      clearScheduledResize();
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        fitAndResize();

        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          fitAndResize();
        });

        resizeSettleTimersRef.current = resizeSettleDelays.map((delay) =>
          window.setTimeout(fitAndResize, delay),
        );
      }, resizeDebounceMs);
    }

    async function startSession() {
      const terminal = terminalRef.current;
      if (!terminal || isStartingRef.current) return;

      isStartingRef.current = true;
      isLifecycleStoppingRef.current = false;
      setIsStarting(true);
      clearOutputQueue();
      lastResizeRef.current = null;
      terminal.reset();

      try {
        const size = isVisibleRef.current ? fitTerminal() ?? { cols: 100, rows: 28 } : { cols: 100, rows: 28 };
        const sessionId = crypto.randomUUID();
        startingSessionIdRef.current = sessionId;
        lastResizeRef.current = size;

        const started = await invoke<TerminalStarted>("terminal_start", {
          sessionId,
          projectId: activeProjectId || null,
          cols: size.cols,
          rows: size.rows,
        });
        if (startingSessionIdRef.current !== started.sessionId || isLifecycleStoppingRef.current) {
          if (startingSessionIdRef.current === started.sessionId) {
            startingSessionIdRef.current = null;
          }
          lastResizeRef.current = null;
          await invoke("terminal_stop", { sessionId: started.sessionId }).catch(() => undefined);
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
        scheduleFitAndResize();
        await flushPendingRawInput(started.sessionId);
      } catch (err) {
        startingSessionIdRef.current = null;
        sessionIdRef.current = null;
        lastResizeRef.current = null;
        const message = String(err);
        terminal.writeln(`\x1b[31m${message}\x1b[0m`);
        onError(message);
      } finally {
        isStartingRef.current = false;
        setIsStarting(false);
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
        terminalRef.current?.focus();
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
      onRuntimeChange(tabId, { session, isStarting });
    }, [isStarting, onRuntimeChange, session, tabId]);

    useEffect(() => {
      isActiveRef.current = isActive;

      if (isActive) {
        scheduleFitAndResize();
      }
    }, [isActive]);

    useEffect(() => {
      isVisibleRef.current = isVisible;
      if (!isVisible) return;

      scheduleFitAndResize();
    }, [isVisible]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

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
        smoothScrollDuration: 0,
        scrollback: 4000,
        theme: getXtermTheme(appearance),
      });
      const fit = new FitAddon();

      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;
      scheduleFitAndResize();

      const bufferDisposable = terminal.buffer.onBufferChange((buffer) => {
        const isAlternateBuffer = buffer.type === "alternate";
        host.classList.toggle("terminal-tui-active", isAlternateBuffer);
        if (isAlternateBuffer) {
          liveTuiSnapshotStartRowRef.current = 0;
          liveTuiOutputQueuedRef.current = true;
          scheduleLiveTuiSnapshot();
        }
      });

      const dataDisposable = terminal.onData((data) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        revealCursorForInput();
        invoke("terminal_write", { sessionId, data }).catch(reportTerminalError);
      });
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
      resizeObserver.observe(host);
      window.addEventListener("resize", scheduleFitAndResize);
      document.addEventListener("fullscreenchange", scheduleFitAndResize);
      window.visualViewport?.addEventListener("resize", scheduleFitAndResize);

      const unlistenOutput = listen<TerminalOutput>("terminal-output", (event) => {
        if (event.payload.sessionId === sessionIdRef.current) {
          enqueueTerminalOutput(event.payload.data);
        }
      });

      const unlistenExit = listen<TerminalExit>("terminal-exit", (event) => {
        if (event.payload.sessionId !== sessionIdRef.current) return;
        sessionIdRef.current = null;
        setSession(null);
        appendConversationMessage("terminal", "会话已结束");
      });

      startSession();

      return () => {
        clearScheduledResize();
        clearPendingSubmitTimer();
        resizeObserver.disconnect();
        window.removeEventListener("resize", scheduleFitAndResize);
        document.removeEventListener("fullscreenchange", scheduleFitAndResize);
        window.visualViewport?.removeEventListener("resize", scheduleFitAndResize);
        host.removeEventListener("paste", pasteListener, { capture: true });
        terminal.attachCustomKeyEventHandler(() => true);
        bufferDisposable.dispose();
        dataDisposable.dispose();
        unlistenOutput.then((unlisten) => unlisten());
        unlistenExit.then((unlisten) => unlisten());
        isLifecycleStoppingRef.current = true;
        clearOutputQueue();
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
      scheduleFitAndResize();
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

    return (
      <div className={`terminal-session ${isVisible ? "visible" : ""} ${isActive ? "active" : ""} mode-${viewMode}`}>
        <div className="terminal-view-switch" role="group" aria-label="显示模式">
          <button
            className={viewMode === "dialog" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("dialog")}
          >
            对话
          </button>
          <button
            className={viewMode === "terminal" ? "active" : ""}
            type="button"
            onClick={() => {
              setViewMode("terminal");
              window.setTimeout(() => terminalRef.current?.focus(), 0);
            }}
          >
            终端
          </button>
        </div>
        <div
          className="terminal-dialog-log"
          ref={conversationLogRef}
          aria-hidden={viewMode !== "dialog"}
          aria-label="对话记录"
        >
          {tuiContextUsage ? (
            <div className="terminal-dialog-context" aria-label="Codex context usage">
              <span className="terminal-dialog-context-label">{getTuiContextLabel(tuiContextUsage)}</span>
              <span className="terminal-dialog-context-meter" aria-hidden="true">
                <span style={{ width: `${getTuiContextUsedPercent(tuiContextUsage)}%` }} />
              </span>
            </div>
          ) : null}
          {conversationMessages.map((message) => (
            <div className={`terminal-dialog-row ${message.role} ${message.kind ?? "normal"}`} key={message.id}>
              <div className="terminal-dialog-bubble">{message.text}</div>
            </div>
          ))}
        </div>
        <div
          className={`terminal-host ${isVisible ? "visible" : ""} ${isActive ? "active" : ""}`}
          ref={hostRef}
          aria-hidden={viewMode !== "terminal"}
        />
      </div>
    );
  },
);
