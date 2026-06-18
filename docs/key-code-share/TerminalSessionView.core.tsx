import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { invoke, listen } from "./tauriRuntime.core";

interface TerminalStarted {
  sessionId: string;
  shell: string;
  cwd: string;
  windowsBuildNumber?: number | null;
}

interface TerminalOutput {
  sessionId: string;
  data: string;
}

interface TerminalExit {
  sessionId: string;
  code?: number | null;
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

const bracketedPasteSubmitDelayMs = 180;

export const TerminalSessionView = forwardRef<
  TerminalSessionHandle,
  { onError: (message: string) => void }
>(function TerminalSessionView({ onError }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingRawInputRef = useRef("");
  const [session, setSession] = useState<TerminalStarted | null>(null);

  function fitAndResize() {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    const sessionId = sessionIdRef.current;
    if (!terminal || !fit || !sessionId) return;

    fit.fit();
    invoke("terminal_resize", {
      sessionId,
      cols: terminal.cols || 100,
      rows: terminal.rows || 28,
    }).catch(() => undefined);
  }

  function writeRawTerminalInput(data: string) {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !data) return;

    invoke("terminal_write", { sessionId, data }).catch((error) => onError(String(error)));
  }

  function sendRawOrQueueInput(data: string) {
    if (!data) return;

    if (sessionIdRef.current) {
      writeRawTerminalInput(data);
      return;
    }

    pendingRawInputRef.current += data;
    void startSession();
  }

  function normalizeInput(input: string) {
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function sendComposerInputToTerminal(input: string) {
    const normalizedInput = normalizeInput(input).trimEnd();
    if (!normalizedInput) return;

    const terminal = terminalRef.current;
    if (terminal?.modes.bracketedPasteMode) {
      sendRawOrQueueInput(`\x1b[200~${normalizedInput}\x1b[201~`);
      window.setTimeout(() => sendRawOrQueueInput("\r"), bracketedPasteSubmitDelayMs);
      return;
    }

    const data = normalizedInput.includes("\n")
      ? `${normalizedInput.replace(/\n/g, "\r")}\r`
      : `${normalizedInput}\r`;
    sendRawOrQueueInput(data);
  }

  async function flushPendingRawInput() {
    const data = pendingRawInputRef.current;
    if (!data) return;

    pendingRawInputRef.current = "";
    writeRawTerminalInput(data);
  }

  async function startSession() {
    const terminal = terminalRef.current;
    if (!terminal) return;

    try {
      const sessionId = crypto.randomUUID();
      const started = await invoke<TerminalStarted>("terminal_start", {
        sessionId,
        cols: terminal.cols || 100,
        rows: terminal.rows || 28,
      });

      if (started.windowsBuildNumber) {
        terminal.options.windowsPty = {
          backend: "conpty",
          buildNumber: started.windowsBuildNumber,
        };
      }

      sessionIdRef.current = started.sessionId;
      setSession(started);
      terminal.clear();
      terminal.writeln(`\x1b[38;5;113m${started.shell}\x1b[0m  \x1b[38;5;245m${started.cwd}\x1b[0m`);
      window.setTimeout(fitAndResize, 0);
      await flushPendingRawInput();
    } catch (error) {
      onError(String(error));
    }
  }

  async function stopSession() {
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    setSession(null);

    if (sessionId) {
      await invoke("terminal_stop", { sessionId }).catch(() => undefined);
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
      fitAndResize();
    },
    interrupt() {
      writeRawTerminalInput("\x03");
    },
    sendRawInput(input: string) {
      sendRawOrQueueInput(input);
    },
    sendComposerInput(input: string) {
      sendComposerInputToTerminal(input);
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.28,
      scrollback: 4000,
      theme: {
        background: "#070b10",
        foreground: "#d7dde7",
        cursor: "#8ab4ff",
      },
    });
    const fit = new FitAddon();

    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const dataDisposable = terminal.onData((data) => {
      writeRawTerminalInput(data);
    });

    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(host);
    window.addEventListener("resize", fitAndResize);

    const unlistenOutput = listen<TerminalOutput>("terminal-output", (event) => {
      if (event.payload.sessionId === sessionIdRef.current) {
        terminal.write(event.payload.data);
      }
    });

    const unlistenExit = listen<TerminalExit>("terminal-exit", (event) => {
      if (event.payload.sessionId !== sessionIdRef.current) return;

      sessionIdRef.current = null;
      setSession(null);
      terminal.writeln("\r\n\x1b[38;5;245m会话已结束\x1b[0m");
    });

    void startSession();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitAndResize);
      dataDisposable.dispose();
      unlistenOutput.then((unlisten) => unlisten());
      unlistenExit.then((unlisten) => unlisten());
      void stopSession();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return (
    <div className="terminal-session">
      <div className="terminal-host" ref={hostRef} />
      <span hidden>{session?.sessionId}</span>
    </div>
  );
});

