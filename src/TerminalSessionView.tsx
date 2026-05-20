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

type ConversationRole = "user" | "terminal";

interface ConversationMessage {
  id: string;
  role: ConversationRole;
  text: string;
  createdAt: number;
  updatedAt: number;
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
    const [session, setSession] = useState<TerminalStarted | null>(null);
    const [isStarting, setIsStarting] = useState(false);
    const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);

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

    function consumePendingEchoLine(line: string) {
      const normalizedLine = line.trim();
      if (!normalizedLine) return false;

      for (const [index, pendingInput] of pendingEchoInputsRef.current.entries()) {
        if (pendingInput === normalizedLine) {
          pendingEchoInputsRef.current.splice(index, 1);
          return true;
        }

        if (pendingInput.startsWith(`${normalizedLine} `)) {
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
        rememberUserConversationInput(normalizedText);
      }

      const now = Date.now();
      setConversationMessages((current) => {
        const last = current[current.length - 1];
        if (
          role === "terminal" &&
          last?.role === "terminal" &&
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

        return [
          ...current,
          {
            id: createConversationId(),
            role,
            text: normalizedText,
            createdAt: now,
            updatedAt: now,
          },
        ].slice(-maxConversationMessages);
      });
    }

    function clearOutputQueue() {
      outputQueueRef.current = [];
      outputWriterActiveRef.current = false;
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
        revealCursorAfterOutputSettles();
        return;
      }

      terminal.write(next, pumpTerminalOutput);
    }

    function enqueueTerminalOutput(data: string) {
      if (!data) return;

      appendConversationMessage("terminal", data);
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

    function formatComposerInput(input: string) {
      const terminal = terminalRef.current;
      const normalizedInput = normalizeInput(input);
      if (!normalizedInput.trim()) return "";

      if (!normalizedInput.includes("\n")) {
        return `${normalizedInput}\r`;
      }

      if (terminal?.modes.bracketedPasteMode) {
        return `\x1b[200~${normalizedInput}\x1b[201~\r`;
      }

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
        sendRawOrQueueInput(formatComposerInput(input));
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
        host.classList.toggle("terminal-tui-active", buffer.type === "alternate");
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
      <div className={`terminal-session ${isVisible ? "visible" : ""} ${isActive ? "active" : ""}`}>
        <div className="terminal-dialog-log" ref={conversationLogRef} aria-label="对话记录">
          {conversationMessages.map((message) => (
            <div className={`terminal-dialog-row ${message.role}`} key={message.id}>
              <div className="terminal-dialog-bubble">{message.text}</div>
            </div>
          ))}
        </div>
        <div
          className={`terminal-host ${isVisible ? "visible" : ""} ${isActive ? "active" : ""}`}
          ref={hostRef}
          aria-hidden
        />
      </div>
    );
  },
);
