import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { defaultTerminalAppearance } from "./terminalThemes";
import type { OpenDialogOptions, OpenDialogReturn } from "@tauri-apps/plugin-dialog";
import type { EventCallback, EventName, Options, UnlistenFn } from "@tauri-apps/api/event";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import type { DirectoryListing, TerminalExit, TerminalOutput, TerminalStarted, WorkbenchState } from "./types";

const previewSessionIdPrefix = "preview-terminal-";
let previewTerminalSequence = 0;
let serverToken: string | null | undefined;
let serverEventsSocket: WebSocket | null = null;
let serverEventsReady: Promise<void> | null = null;
const serverEventHandlers = new Map<string, Set<EventCallback<unknown>>>();

const previewState: WorkbenchState = {
  projects: [],
  activeProjectId: null,
  terminalAppearance: defaultTerminalAppearance,
  customTerminalAppearance: defaultTerminalAppearance,
};

function getPreviewCwd() {
  return window.location.hostname || "browser-preview";
}

function getPreviewTerminalStarted(args?: InvokeArgs): TerminalStarted {
  const requestedSessionId =
    args && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array)
      ? typeof args.sessionId === "string"
        ? args.sessionId
        : null
      : null;

  previewTerminalSequence += 1;
  return {
    sessionId: requestedSessionId || `${previewSessionIdPrefix}${previewTerminalSequence}`,
    shell: "Browser preview",
    cwd: getPreviewCwd(),
    windowsBuildNumber: null,
  };
}

async function previewInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  switch (cmd) {
    case "load_state":
      return previewState as T;
    case "initial_project_id":
      return null as T;
    case "list_directory":
      return ({
        path: getPreviewCwd(),
        parentPath: null,
        entries: [],
      } satisfies DirectoryListing) as T;
    case "create_directory":
      return ({
        path: getPreviewCwd(),
        parentPath: null,
        entries: [],
      } satisfies DirectoryListing) as T;
    case "set_terminal_appearance":
      if (args && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array)) {
        previewState.terminalAppearance = args.appearance as WorkbenchState["terminalAppearance"];
      }
      return previewState as T;
    case "terminal_start":
      return getPreviewTerminalStarted(args) as T;
    case "terminal_write":
    case "terminal_resize":
    case "terminal_stop":
      return undefined as T;
    case "save_pasted_image":
      return "C:\\Temp\\code-terminal\\pasted-images\\preview-paste.png" as T;
    default:
      return Promise.reject(new Error(`Tauri command "${cmd}" is not available in browser preview.`));
  }
}

function readServerToken() {
  if (serverToken !== undefined) return serverToken;

  try {
    serverToken =
      new URLSearchParams(window.location.search).get("token") ||
      window.localStorage.getItem("code-terminal.server-token") ||
      null;
    if (serverToken) {
      window.localStorage.setItem("code-terminal.server-token", serverToken);
    }
  } catch {
    serverToken = null;
  }

  return serverToken;
}

function serverApiUrl(command: string) {
  const token = readServerToken();
  const url = new URL(`/api/${command}`, window.location.origin);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url;
}

async function serverInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  if (serverEventHandlers.size > 0 && isTerminalEventProducingCommand(cmd)) {
    await ensureServerEventsSocket();
  }

  const init: RequestInit = {
    headers: {
      "content-type": "application/json",
    },
  };
  const isGet = cmd === "load_state" || cmd === "initial_project_id";
  if (!isGet) {
    init.method = "POST";
    init.body = JSON.stringify(args ?? {});
  }

  const response = await fetch(serverApiUrl(cmd), init);
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || response.statusText);
  }
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function isTerminalEventProducingCommand(command: string) {
  return command === "terminal_start" || command === "terminal_write";
}

function isServerRuntime() {
  const port = window.location.port;
  const hostname = window.location.hostname;
  const isLocalVitePreview = port === "1420" && (hostname === "127.0.0.1" || hostname === "localhost");
  return !isTauriRuntime() && window.location.protocol !== "file:" && !isLocalVitePreview;
}

export function canUseNativeOpenDialog() {
  return isTauriRuntime();
}

function serverEventsUrl() {
  const token = readServerToken();
  const url = new URL("/api/events", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) {
    url.searchParams.set("token", token);
  }
  return url;
}

function normalizeServerEventName(type: string) {
  switch (type) {
    case "terminalOutput":
      return "terminal-output";
    case "terminalExit":
      return "terminal-exit";
    default:
      return type;
  }
}

function ensureServerEventsSocket(): Promise<void> {
  if (serverEventsSocket?.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (serverEventsSocket?.readyState === WebSocket.CONNECTING && serverEventsReady) {
    return serverEventsReady;
  }

  const socket = new WebSocket(serverEventsUrl());
  serverEventsSocket = socket;
  serverEventsReady = new Promise((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleUnavailable = () => {
      cleanup();
      reject(new Error("服务器事件通道连接失败"));
    };
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleUnavailable);
      socket.removeEventListener("close", handleUnavailable);
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleUnavailable);
    socket.addEventListener("close", handleUnavailable);
  });

  socket.addEventListener("message", (event) => {
    let payload: {
      type?: string;
      payload?: TerminalOutput | TerminalExit;
      terminalOutput?: TerminalOutput;
      terminalExit?: TerminalExit;
      terminal_output?: TerminalOutput;
      terminal_exit?: TerminalExit;
    };

    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (!payload.type) return;

    const eventName = normalizeServerEventName(payload.type);
    const eventPayload =
      payload.payload ?? payload.terminalOutput ?? payload.terminal_output ?? payload.terminalExit ?? payload.terminal_exit;
    if (!eventPayload) return;

    serverEventHandlers.get(eventName)?.forEach((handler) => {
      handler({ event: eventName, id: 0, payload: eventPayload } as Parameters<typeof handler>[0]);
    });
  });
  socket.addEventListener("close", () => {
    if (serverEventsSocket === socket) {
      serverEventsSocket = null;
      serverEventsReady = null;
    }
    if (serverEventHandlers.size > 0) {
      window.setTimeout(() => {
        void ensureServerEventsSocket().catch(() => undefined);
      }, 1200);
    }
  });

  return serverEventsReady;
}

export function isTauriRuntime() {
  return isTauri();
}

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(cmd, args, options);
  }

  if (isServerRuntime()) {
    return serverInvoke<T>(cmd, args);
  }

  return previewInvoke<T>(cmd, args);
}

export function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return tauriListen<T>(event, handler, options);
  }

  if (isServerRuntime() && (event === "terminal-output" || event === "terminal-exit")) {
    const handlers = serverEventHandlers.get(event) ?? new Set<EventCallback<unknown>>();
    handlers.add(handler as EventCallback<unknown>);
    serverEventHandlers.set(event, handlers);
    void ensureServerEventsSocket().catch(() => undefined);
    return Promise.resolve(() => {
      handlers.delete(handler as EventCallback<unknown>);
      if (handlers.size === 0) {
        serverEventHandlers.delete(event);
      }
      if (serverEventHandlers.size === 0) {
        serverEventsSocket?.close();
        serverEventsSocket = null;
        serverEventsReady = null;
      }
    });
  }

  void options;
  return Promise.resolve(() => undefined);
}

export function setWindowTitle(title: string) {
  document.title = title;
  if (!isTauriRuntime()) return Promise.resolve();

  return getCurrentWindow().setTitle(title);
}

export function startWindowDrag() {
  if (!isTauriRuntime()) return Promise.resolve();

  return getCurrentWindow().startDragging();
}

export function minimizeWindow() {
  if (!isTauriRuntime()) return Promise.resolve();

  return getCurrentWindow().minimize();
}

export function toggleWindowMaximize() {
  if (!isTauriRuntime()) return Promise.resolve();

  return getCurrentWindow().toggleMaximize();
}

export function closeWindow() {
  if (!isTauriRuntime()) return Promise.resolve();

  return getCurrentWindow().close();
}

export function openDialog<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>> {
  if (isTauriRuntime()) {
    return tauriOpen(options);
  }

  return Promise.resolve(null as OpenDialogReturn<T>);
}
