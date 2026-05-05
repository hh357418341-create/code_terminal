import { Columns2, Grid2X2, Maximize2, Plus, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type TerminalLayoutMode = "single" | "split" | "grid";

const terminalLayoutModes: Array<{
  mode: TerminalLayoutMode;
  label: string;
  title: string;
  visibleCount: number;
  icon: typeof Maximize2;
}> = [
  { mode: "single", label: "单窗", title: "单窗口布局", visibleCount: 1, icon: Maximize2 },
  { mode: "split", label: "双列", title: "左右双窗口布局", visibleCount: 2, icon: Columns2 },
  { mode: "grid", label: "2x2", title: "2x2 四窗口布局", visibleCount: 4, icon: Grid2X2 },
];

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
  const [layoutMode, setLayoutMode] = useState<TerminalLayoutMode>("single");
  const [tabRuntime, setTabRuntime] = useState<Record<string, TerminalSessionRuntime>>({});
  const [routedCommand, setRoutedCommand] = useState<{
    tabId: string;
    request: TerminalCommandRequest;
  } | null>(null);

  const activeRuntime = tabRuntime[terminalTabs.activeTabId];
  const activeCwd = activeRuntime?.session?.cwd || activeProjectPath || "未绑定项目目录";
  const activeLayout = terminalLayoutModes.find((layout) => layout.mode === layoutMode) ?? terminalLayoutModes[0];
  const visibleTabs = useMemo(() => {
    const activeIndex = terminalTabs.tabs.findIndex((tab) => tab.id === terminalTabs.activeTabId);
    if (activeIndex < 0) return terminalTabs.tabs.slice(0, activeLayout.visibleCount);

    const pageStart =
      Math.floor(activeIndex / activeLayout.visibleCount) * activeLayout.visibleCount;
    return terminalTabs.tabs.slice(pageStart, pageStart + activeLayout.visibleCount);
  }, [activeLayout.visibleCount, terminalTabs.activeTabId, terminalTabs.tabs]);
  const visibleTabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs]);

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

  useEffect(() => {
    window.setTimeout(() => {
      visibleTabs.forEach((tab) => terminalHandlesRef.current[tab.id]?.fit());
    }, 0);
  }, [layoutMode, visibleTabs]);

  function addTerminalTab() {
    const tab = createTerminalTab(nextTabIndexRef.current);
    nextTabIndexRef.current += 1;

    setTerminalTabs((current) => ({
      tabs: [...current.tabs, tab],
      activeTabId: tab.id,
    }));
  }

  function ensureLayoutTerminals(mode: TerminalLayoutMode) {
    const layout = terminalLayoutModes.find((item) => item.mode === mode) ?? terminalLayoutModes[0];

    setTerminalTabs((current) => {
      if (current.tabs.length >= layout.visibleCount) return current;

      const tabs = [...current.tabs];
      while (tabs.length < layout.visibleCount) {
        tabs.push(createTerminalTab(nextTabIndexRef.current));
        nextTabIndexRef.current += 1;
      }

      return {
        ...current,
        tabs,
      };
    });
  }

  function changeLayoutMode(mode: TerminalLayoutMode) {
    setLayoutMode(mode);
    ensureLayoutTerminals(mode);
    window.setTimeout(() => terminalHandlesRef.current[terminalTabs.activeTabId]?.focus(), 0);
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
          <div className="terminal-layout-switch" aria-label="终端布局">
            {terminalLayoutModes.map((layout) => {
              const Icon = layout.icon;
              return (
                <button
                  key={layout.mode}
                  className={`terminal-layout-button ${layoutMode === layout.mode ? "active" : ""}`}
                  title={layout.title}
                  onClick={() => changeLayoutMode(layout.mode)}
                >
                  <Icon size={14} />
                  <span>{layout.label}</span>
                </button>
              );
            })}
          </div>
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

      <div className={`terminal-surface layout-${layoutMode}`}>
        {terminalTabs.tabs.map((tab) => (
          <div
            className={`terminal-cell ${tab.id === terminalTabs.activeTabId ? "active" : ""} ${
              visibleTabIds.has(tab.id) ? "visible" : ""
            }`}
            key={tab.id}
            onMouseDown={() => focusTerminal(tab.id)}
          >
            <div className="terminal-cell-header">
              <span>{tab.title}</span>
              <span>{tabRuntime[tab.id]?.session?.cwd || activeProjectPath || "未绑定项目目录"}</span>
            </div>
            <TerminalSessionView
              ref={(handle) => {
                if (handle) {
                  terminalHandlesRef.current[tab.id] = handle;
                } else {
                  delete terminalHandlesRef.current[tab.id];
                }
              }}
              tabId={tab.id}
              isActive={tab.id === terminalTabs.activeTabId}
              isVisible={visibleTabIds.has(tab.id)}
              activeProjectId={activeProjectId}
              appearance={appearance}
              commandRequest={routedCommand?.tabId === tab.id ? routedCommand.request : null}
              onError={onError}
              onRuntimeChange={updateRuntime}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
