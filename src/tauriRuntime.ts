import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { defaultTerminalAppearance } from "./terminalThemes";
import type { OpenDialogOptions, OpenDialogReturn } from "@tauri-apps/plugin-dialog";
import type { EventCallback, EventName, Options, UnlistenFn } from "@tauri-apps/api/event";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import type { TerminalStarted, WorkbenchState } from "./types";

const previewSessionIdPrefix = "preview-terminal-";
let previewTerminalSequence = 0;

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

export function isTauriRuntime() {
  return isTauri();
}

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(cmd, args, options);
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

  void event;
  void handler;
  void options;
  return Promise.resolve(() => undefined);
}

export function setWindowTitle(title: string) {
  document.title = title;
  if (!isTauriRuntime()) return Promise.resolve();

  return getCurrentWindow().setTitle(title);
}

export function openDialog<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>> {
  if (isTauriRuntime()) {
    return tauriOpen(options);
  }

  return Promise.resolve(null as OpenDialogReturn<T>);
}
