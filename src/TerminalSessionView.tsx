import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
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

interface SavedPastedImage {
  path: string;
}

interface EditableSelectionRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
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
    const startingSessionIdRef = useRef<string | null>(null);
    const resizeTimerRef = useRef<number | null>(null);
    const resizeFrameRef = useRef<number | null>(null);
    const resizeSettleTimersRef = useRef<number[]>([]);
    const isStartingRef = useRef(false);
    const isActiveRef = useRef(isActive);
    const isVisibleRef = useRef(isVisible);
    const pendingCommandRef = useRef<string | null>(null);
    const lastCommandIdRef = useRef<number | null>(null);
    const isLifecycleStoppingRef = useRef(false);
    const outputQueueRef = useRef<string[]>([]);
    const outputWriterActiveRef = useRef(false);
    const outputCursorTimerRef = useRef<number | null>(null);
    const outputCursorSuppressedRef = useRef(false);
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const [session, setSession] = useState<TerminalStarted | null>(null);
    const [isStarting, setIsStarting] = useState(false);

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

    function getClipboardImageItem(dataTransfer: DataTransfer | null) {
      if (!dataTransfer) return null;

      const items = Array.from(dataTransfer.items);
      return items.find((item) => item.kind === "file" && item.type.startsWith("image/")) ?? null;
    }

    async function saveClipboardImage(item: DataTransferItem) {
      const file = item.getAsFile();
      if (!file) return null;

      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const path = await invoke<string>("save_pasted_image", {
        mimeType: file.type || item.type,
        bytes,
      });

      return path;
    }

    function formatPastedImagePath(path: string) {
      return `"${path.replace(/"/g, '\\"')}"`;
    }

    function isPasteShortcut(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      return (
        event.type === "keydown" &&
        (((event.ctrlKey || event.metaKey) && !event.altKey && key === "v") ||
          (event.shiftKey && !event.ctrlKey && !event.metaKey && key === "insert"))
      );
    }

    function isDeletionShortcut(event: KeyboardEvent) {
      return (
        event.type === "keydown" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        (event.key === "Backspace" || event.key === "Delete")
      );
    }

    function orderedSelectionRange(range: EditableSelectionRange): EditableSelectionRange {
      const isReversed =
        range.startY > range.endY ||
        (range.startY === range.endY && range.startX > range.endX);

      if (!isReversed) return range;

      return {
        startX: range.endX,
        startY: range.endY,
        endX: range.startX,
        endY: range.startY,
      };
    }

    function getEditableSelectionRange(terminal: XTerm) {
      const rawRange = terminal.getSelectionPosition();
      const buffer = terminal.buffer.active;
      if (!rawRange || buffer.type !== "normal") return null;

      const cursorRow = buffer.baseY + buffer.cursorY;
      const range = orderedSelectionRange({
        startX: rawRange.start.x,
        startY: rawRange.start.y,
        endX: rawRange.end.x,
        endY: rawRange.end.y,
      });

      if (
        range.startY === cursorRow &&
        range.endY === cursorRow &&
        range.startX >= 0 &&
        range.endX > range.startX &&
        range.endX <= terminal.cols &&
        range.startY >= 0 &&
        range.startY < buffer.length
      ) {
        return range;
      }

      return null;
    }

    function countLineCharacters(terminal: XTerm, row: number, startX: number, endX: number) {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(row);
      if (!line) return 0;

      const reusableCell = buffer.getNullCell();
      let count = 0;
      for (let column = startX; column < endX; column += 1) {
        const cell = line.getCell(column, reusableCell);
        if (cell && cell.getWidth() > 0) {
          count += 1;
        }
      }

      return count;
    }

    function countSelectedCharacters(terminal: XTerm, range: EditableSelectionRange) {
      const count = countLineCharacters(terminal, range.startY, range.startX, range.endX);
      return count || Array.from(terminal.getSelection().replace(/\r?\n/g, "")).length;
    }

    function repeatSequence(sequence: string, count: number) {
      return count > 0 ? sequence.repeat(count) : "";
    }

    function deleteEditableSelection(terminal: XTerm) {
      if (!terminal.hasSelection()) return false;

      const range = getEditableSelectionRange(terminal);
      if (!range) {
        terminal.clearSelection();
        return true;
      }

      const deleteCount = countSelectedCharacters(terminal, range);
      if (deleteCount <= 0) {
        terminal.clearSelection();
        return true;
      }

      const cursorX = terminal.buffer.active.cursorX;
      const moveCount = countLineCharacters(
        terminal,
        range.startY,
        Math.min(cursorX, range.endX),
        Math.max(cursorX, range.endX),
      );
      const moveToSelectionEnd =
        range.endX < cursorX
          ? repeatSequence("\x1b[D", moveCount)
          : repeatSequence("\x1b[C", moveCount);

      terminal.clearSelection();
      writeRawTerminalInput(`${moveToSelectionEnd}${repeatSequence("\x7f", deleteCount)}`);
      return true;
    }

    function handleSelectionDeleteShortcut(event: KeyboardEvent) {
      if (!isDeletionShortcut(event)) return false;

      const terminal = terminalRef.current;
      if (!terminal?.hasSelection()) return false;

      event.preventDefault();
      event.stopPropagation();
      return deleteEditableSelection(terminal);
    }

    async function stopSession() {
      const sessionId = sessionIdRef.current;
      startingSessionIdRef.current = null;
      sessionIdRef.current = null;
      lastResizeRef.current = null;
      setSession(null);
      clearOutputQueue();
      if (sessionId) {
        await invoke("terminal_stop", { sessionId }).catch(() => undefined);
      }
    }

    async function flushPendingCommand(sessionId: string) {
      const command = pendingCommandRef.current;
      const terminal = terminalRef.current;
      if (!command) return;

      pendingCommandRef.current = null;
      terminal?.writeln("");
      terminal?.writeln(`\x1b[38;5;113m$ ${command}\x1b[0m`);

      await invoke("terminal_write", {
        sessionId,
        data: `${command}\r`,
      }).catch(reportTerminalError);
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
        terminal.clear();
        terminal.writeln(`\x1b[38;5;113m${started.shell}\x1b[0m  \x1b[38;5;245m${started.cwd}\x1b[0m`);
        if (!isTauriRuntime()) {
          terminal.writeln(`\x1b[38;5;245m${browserPreviewMessage}\x1b[0m`);
        }
        scheduleFitAndResize();
        await flushPendingCommand(started.sessionId);
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
    }));

    useEffect(() => {
      onRuntimeChange(tabId, { session, isStarting });
    }, [isStarting, onRuntimeChange, session, tabId]);

    useEffect(() => {
      isActiveRef.current = isActive;

      if (isActive) {
        scheduleFitAndResize();
        terminalRef.current?.focus();
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

      const terminal = new XTerm({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorInactiveStyle: "block",
        cursorStyle: "block",
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
        return !handleSelectionDeleteShortcut(event);
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
      pendingCommandRef.current = commandRequest.command;

      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void flushPendingCommand(sessionId);
      } else {
        void startSession();
      }
    }, [commandRequest?.id]);

    return (
      <div
        className={`terminal-host ${isVisible ? "visible" : ""} ${isActive ? "active" : ""}`}
        ref={hostRef}
        aria-hidden={!isVisible}
      />
    );
  },
);
