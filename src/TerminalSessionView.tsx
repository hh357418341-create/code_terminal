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
const maxLiveTuiTranscriptChars = 32000;
const bracketedPasteSubmitDelayMs = 180;
const codexStatusWords = ["Working", "Thinking", "Reading", "Editing", "Running"];
const terminalViewModeStorageKey = "code-terminal-view-mode";

type ConversationRole = "user" | "terminal";
type ConversationMessageKind = "normal" | "tui";
type TerminalViewMode = "dialog" | "terminal";

interface ConversationLine {
  text: string;
  muted?: boolean;
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
    const liveTuiTranscriptRowsRef = useRef<ConversationLine[]>([]);
    const codexWelcomeMessageIdRef = useRef<string | null>(null);
    const dialogConversationStartedRef = useRef(false);
    const pendingSubmitTimerRef = useRef<number | null>(null);
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

    function isCodexTuiNoiseLine(line: string, shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return false;

      const text = line.trim();
      if (!text) return false;
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
        /\bSummarize recent commits\b/i.test(text) ||
        /\bFind and fix a bug in @filename\b/i.test(text) ||
        /\bImprove documentation in @filename\b/i.test(text)
      );
    }

    function cleanCodexTuiChromeLine(line: string, shouldCleanCodexChrome: boolean) {
      if (!shouldCleanCodexChrome) return line;

      let text = line.trimEnd();
      if (/^[╭╰─│\s>_OpenAI Codex().v0-9]+$/.test(text)) return "";
      if (/^\s*│/.test(text)) return "";
      if (/^\s*╭/.test(text) || /^\s*╰/.test(text)) return "";
      if (isCodexTuiWelcomeOrPromptChromeLine(text)) return "";
      if (/\bOpenAI Codex\b/i.test(text)) return "";
      if (/\b(model|directory|permissions):/i.test(text)) return "";
      if (/\bTip:\b/i.test(text)) return "";
      text = text.replace(/[>›]\s*Improve.*$/i, "").trimEnd();
      text = text.replace(/\([^)]*\besc to interrupt\b[^)]*\)/gi, "").trimEnd();

      const statusInFooter = text.match(/\b(Working|Thinking|Reading|Editing|Running)\b\s*$/i);
      if (/\bContext\s+\d+%\s+(?:left|used)\b/i.test(text)) {
        return statusInFooter ? statusInFooter[1] : "";
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

      return (
        isCodexTuiWelcomeOrPromptChromeLine(text) ||
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

    function normalizeTranscriptComparison(row: ConversationLine) {
      return normalizeEchoComparison(row.text);
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
        (line, index) => line.text === second[index].text && Boolean(line.muted) === Boolean(second[index].muted),
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
      const recentUserInputs = new Set(recentUserInputsRef.current.map((input) => input.trim()).filter(Boolean));
      let rows = rawRows
        .map((row) => ({
          ...row,
          text: row.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""),
        }))
        .map(stripPromptPrefixForSnapshotRow);
      const shouldCleanCodexChrome = hasCodexTuiChrome(rows.map((row) => row.text));

      rows = rows
        .map((row) => ({
          ...row,
          text: cleanCodexTuiChromeLine(row.text, shouldCleanCodexChrome),
        }))
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

    function upsertLiveTuiMessage(rows: ConversationLine[]) {
      const hasCodexWelcome = upsertCodexWelcomeMessage(rows);
      if (!dialogConversationStartedRef.current && !hasCodexWelcome) return;

      const normalizedRows = normalizeSnapshotRows(rows);
      const nextTranscriptRows = compactConversationRows(
        mergeTuiTranscriptRows(liveTuiTranscriptRowsRef.current, normalizedRows),
      );
      const nextTranscriptText = buildTextFromRows(nextTranscriptRows);
      if (!nextTranscriptText.trim()) return;

      liveTuiTranscriptRowsRef.current = nextTranscriptRows;

      const now = Date.now();
      const messageId = liveTuiMessageIdRef.current ?? createConversationId();
      liveTuiMessageIdRef.current = messageId;

      setConversationMessages((current) => {
        const existingIndex = current.findIndex((message) => message.id === messageId);
        if (existingIndex >= 0) {
          const existing = current[existingIndex];
          if (
            existing.text === nextTranscriptText &&
            existing.kind === "tui" &&
            areConversationLinesEqual(existing.lines, nextTranscriptRows)
          ) {
            return current;
          }

          const nextMessages = [...current];
          nextMessages[existingIndex] = {
            ...existing,
            kind: "tui",
            text: nextTranscriptText,
            lines: nextTranscriptRows,
            updatedAt: now,
          };
          return nextMessages;
        }

        const nextMessage: ConversationMessage = {
          id: messageId,
          role: "terminal",
          kind: "tui",
          text: nextTranscriptText,
          lines: nextTranscriptRows,
          createdAt: now,
          updatedAt: now,
        };

        return [...current, nextMessage].slice(-maxConversationMessages);
      });
    }

    function captureLiveTuiSnapshot() {
      const snapshotRows = getTerminalScreenRows();
      if (buildTextFromRows(snapshotRows).trim()) {
        upsertLiveTuiMessage(snapshotRows);
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

    function scheduleLiveTuiSnapshot() {
      clearLiveTuiSnapshotTimer();
      liveTuiSnapshotTimerRef.current = window.setTimeout(() => {
        liveTuiSnapshotTimerRef.current = null;
        captureLiveTuiSnapshot();
      }, liveTuiSnapshotDebounceMs);
    }

    function showDialogView() {
      setViewMode("dialog");
      rememberTerminalViewMode("dialog");
      window.setTimeout(() => {
        scheduleFitAndResize();
        if (hasLiveTuiSnapshotContext()) {
          captureLiveTuiSnapshot();
        }
      }, 0);
    }

    function showTerminalView() {
      setViewMode("terminal");
      rememberTerminalViewMode("terminal");
      window.setTimeout(() => {
        scheduleFitAndResize();
        terminalRef.current?.focus();
      }, 0);
    }

    function rememberTerminalViewMode(nextViewMode: TerminalViewMode) {
      try {
        localStorage.setItem(terminalViewModeStorageKey, nextViewMode);
      } catch {
        // Ignore storage failures; the active view still changes for this session.
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
              lines: undefined,
              updatedAt: now,
            },
          ].slice(-maxConversationMessages);
        }

        const nextMessage: ConversationMessage = {
          id: createConversationId(),
          role,
          kind: "normal",
          text: normalizedText,
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
          captureLiveTuiSnapshot();
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
      const terminal = terminalRef.current;
      if (dialogConversationStartedRef.current || terminal?.buffer.active.type !== "alternate") return;

      const printableInput = data
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[@-Z\\-_]/g, "")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim();
      if (printableInput || /[\r\n]/.test(data)) {
        dialogConversationStartedRef.current = true;
      }
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
        markDialogConversationStartedFromTerminalInput(data);
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
        dialogConversationStartedRef.current = false;
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
        dialogConversationStartedRef.current = false;
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
