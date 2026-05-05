import { Plus, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TerminalSessionView,
  type TerminalSessionHandle,
  type TerminalSessionRuntime,
} from "./TerminalSessionView";
import type { TerminalAppearanceSettings, TerminalCommandRequest } from "./types";

interface TerminalPaneProps {
  activeProjectId?: string | null;
  activeProjectPath?: string | null;
  appearance: TerminalAppearanceSettings;
  commandRequest?: TerminalCommandRequest | null;
  onError: (message: string) => void;
}

interface TerminalTab {
  id: string;
  title: string;
}

interface TerminalTabsState {
  tabs: TerminalTab[];
  activeTabId: string;
}

function createTerminalTab(index: number): TerminalTab {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

  return {
    id,
    title: `终端 ${index}`,
  };
}

function createInitialTabs(): TerminalTabsState {
  const tab = createTerminalTab(1);
  return {
    tabs: [tab],
    activeTabId: tab.id,
  };
}

export function TerminalPane({
  activeProjectId,
  activeProjectPath,
  appearance,
  commandRequest,
  onError,
}: TerminalPaneProps) {
  const nextTabIndexRef = useRef(2);
  const terminalHandlesRef = useRef<Record<string, TerminalSessionHandle | undefined>>({});
  const terminalTabsRef = useRef<HTMLDivElement | null>(null);
  const terminalTabElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const lastRoutedCommandIdRef = useRef<number | null>(null);
  const previousProjectIdRef = useRef(activeProjectId);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTabsState>(createInitialTabs);
  const [tabRuntime, setTabRuntime] = useState<Record<string, TerminalSessionRuntime>>({});
  const [routedCommand, setRoutedCommand] = useState<{
    tabId: string;
    request: TerminalCommandRequest;
  } | null>(null);

  const activeRuntime = tabRuntime[terminalTabs.activeTabId];
  const activeCwd = activeRuntime?.session?.cwd || activeProjectPath || "未绑定项目目录";

  const updateRuntime = useCallback((tabId: string, runtime: TerminalSessionRuntime) => {
    setTabRuntime((current) => ({
      ...current,
      [tabId]: runtime,
    }));
  }, []);

  useEffect(() => {
    if (previousProjectIdRef.current === activeProjectId) return;

    previousProjectIdRef.current = activeProjectId;
    const next = createInitialTabs();
    nextTabIndexRef.current = 2;
    terminalHandlesRef.current = {};
    lastRoutedCommandIdRef.current = null;
    setRoutedCommand(null);
    setTabRuntime({});
    setTerminalTabs(next);
  }, [activeProjectId]);

  useEffect(() => {
    if (!commandRequest || lastRoutedCommandIdRef.current === commandRequest.id) return;

    lastRoutedCommandIdRef.current = commandRequest.id;
    setRoutedCommand({
      tabId: terminalTabs.activeTabId,
      request: commandRequest,
    });
  }, [commandRequest, terminalTabs.activeTabId]);

  useEffect(() => {
    terminalTabElementsRef.current[terminalTabs.activeTabId]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [terminalTabs.activeTabId, terminalTabs.tabs.length]);

  function addTerminalTab() {
    const tab = createTerminalTab(nextTabIndexRef.current);
    nextTabIndexRef.current += 1;

    setTerminalTabs((current) => ({
      tabs: [...current.tabs, tab],
      activeTabId: tab.id,
    }));
  }

  function closeTerminalTab(tabId: string) {
    setTabRuntime((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setRoutedCommand((current) => (current?.tabId === tabId ? null : current));

    setTerminalTabs((current) => {
      if (current.tabs.length <= 1) return current;

      const closingIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const fallbackTab = tabs[Math.max(0, closingIndex - 1)] ?? tabs[0];

      return {
        tabs,
        activeTabId: current.activeTabId === tabId ? fallbackTab.id : current.activeTabId,
      };
    });
  }

  function restartActiveTerminal() {
    void terminalHandlesRef.current[terminalTabs.activeTabId]?.restartSession();
  }

  function stopActiveTerminal() {
    void terminalHandlesRef.current[terminalTabs.activeTabId]?.stopSession();
  }

  function focusTerminal(tabId: string) {
    setTerminalTabs((current) => ({
      ...current,
      activeTabId: tabId,
    }));
    window.setTimeout(() => terminalHandlesRef.current[tabId]?.focus(), 0);
  }

  return (
    <section className="terminal-pane">
      <header className="terminal-bar">
        <div className="terminal-tab-strip">
          <strong className="terminal-bar-title">本地终端</strong>
          <div
            className="terminal-tabs"
            ref={terminalTabsRef}
            role="tablist"
            aria-label="终端列表"
            onWheel={(event) => {
              const tabs = terminalTabsRef.current;
              if (!tabs || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

              tabs.scrollLeft += event.deltaY;
              event.preventDefault();
            }}
          >
            {terminalTabs.tabs.map((tab) => {
              const runtime = tabRuntime[tab.id];
              const isActive = tab.id === terminalTabs.activeTabId;
              const status = runtime?.isStarting ? "starting" : runtime?.session ? "running" : "stopped";

              return (
                <div
                  className={`terminal-tab ${isActive ? "active" : ""}`}
                  key={tab.id}
                  ref={(element) => {
                    terminalTabElementsRef.current[tab.id] = element;
                  }}
                >
                  <button
                    className="terminal-tab-main"
                    role="tab"
                    aria-selected={isActive}
                    title={runtime?.session?.cwd || activeProjectPath || tab.title}
                    onClick={() => focusTerminal(tab.id)}
                  >
                    <span className={`terminal-tab-dot ${status}`} />
                    <span>{tab.title}</span>
                  </button>
                  {terminalTabs.tabs.length > 1 && (
                    <button
                      className="terminal-tab-close"
                      title="关闭终端"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTerminalTab(tab.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button className="terminal-tab-add" title="新建终端" onClick={addTerminalTab}>
            <Plus size={14} />
          </button>
          <span className="terminal-active-path" title={activeCwd}>
            {activeCwd}
          </span>
        </div>

        <div className="terminal-actions">
          <button
            className="terminal-action"
            title="重启当前终端"
            disabled={activeRuntime?.isStarting}
            onClick={restartActiveTerminal}
          >
            <RotateCcw size={14} />
            重启
          </button>
          <button
            className="terminal-action"
            title="停止当前终端"
            disabled={!activeRuntime?.session}
            onClick={stopActiveTerminal}
          >
            <Square size={13} />
            停止
          </button>
        </div>
      </header>

      <div className="terminal-surface">
        {terminalTabs.tabs.map((tab) => (
          <TerminalSessionView
            key={tab.id}
            ref={(handle) => {
              if (handle) {
                terminalHandlesRef.current[tab.id] = handle;
              } else {
                delete terminalHandlesRef.current[tab.id];
              }
            }}
            tabId={tab.id}
            isActive={tab.id === terminalTabs.activeTabId}
            activeProjectId={activeProjectId}
            appearance={appearance}
            commandRequest={routedCommand?.tabId === tab.id ? routedCommand.request : null}
            onError={onError}
            onRuntimeChange={updateRuntime}
          />
        ))}
      </div>
    </section>
  );
}
