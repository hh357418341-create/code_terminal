import { Grid2X2, Plus, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
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

type TerminalLayoutMode = "1x1" | "1x2" | "2x2" | "2x3" | "3x3";
type ResizeAxis = "column" | "row";

interface ResizeDragState {
  axis: ResizeAxis;
  index: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSizes: number[];
}

const terminalLayoutModes: Array<{
  mode: TerminalLayoutMode;
  label: string;
  title: string;
  rows: number;
  columns: number;
  visibleCount: number;
}> = [
  { mode: "1x1", label: "1x1", title: "1 行 1 列", rows: 1, columns: 1, visibleCount: 1 },
  { mode: "1x2", label: "1x2", title: "1 行 2 列", rows: 1, columns: 2, visibleCount: 2 },
  { mode: "2x2", label: "2x2", title: "2 行 2 列", rows: 2, columns: 2, visibleCount: 4 },
  { mode: "2x3", label: "2x3", title: "2 行 3 列", rows: 2, columns: 3, visibleCount: 6 },
  { mode: "3x3", label: "3x3", title: "3 行 3 列", rows: 3, columns: 3, visibleCount: 9 },
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

function formatTerminalPath(path?: string | null) {
  if (!path) return "未绑定项目目录";

  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return path;

  return `.../${parts.slice(-3).join("/")}`;
}

function createEqualWeights(count: number) {
  return Array.from({ length: Math.max(1, count) }, () => 1);
}

function formatGridWeights(weights: number[]) {
  return weights.map((weight) => `minmax(0, ${Math.max(0.2, weight).toFixed(4)}fr)`).join(" ");
}

function getResizeBoundaryPercent(weights: number[], index: number) {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const offset = weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0);
  return (offset / total) * 100;
}

function resizeAdjacentWeights(startSizes: number[], index: number, delta: number, containerSize: number) {
  const total = startSizes.reduce((sum, size) => sum + size, 0) || 1;
  const deltaWeight = (delta / Math.max(1, containerSize)) * total;
  const minWeight = 0.35;
  const next = [...startSizes];
  const pairTotal = startSizes[index] + startSizes[index + 1];
  const first = Math.min(pairTotal - minWeight, Math.max(minWeight, startSizes[index] + deltaWeight));

  next[index] = first;
  next[index + 1] = pairTotal - first;

  return next;
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
  const terminalSurfaceRef = useRef<HTMLDivElement | null>(null);
  const terminalFitFrameRef = useRef<number | null>(null);
  const terminalFitSettleTimersRef = useRef<number[]>([]);
  const resizeDragRef = useRef<ResizeDragState | null>(null);
  const lastRoutedCommandIdRef = useRef<number | null>(null);
  const previousProjectIdRef = useRef(activeProjectId);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTabsState>(createInitialTabs);
  const [layoutMode, setLayoutMode] = useState<TerminalLayoutMode>("1x1");
  const activeLayout = terminalLayoutModes.find((layout) => layout.mode === layoutMode) ?? terminalLayoutModes[0];
  const [columnWeights, setColumnWeights] = useState(() => createEqualWeights(activeLayout.columns));
  const [rowWeights, setRowWeights] = useState(() => createEqualWeights(activeLayout.rows));
  const [isResizingLayout, setIsResizingLayout] = useState(false);
  const [tabRuntime, setTabRuntime] = useState<Record<string, TerminalSessionRuntime>>({});
  const [routedCommand, setRoutedCommand] = useState<{
    tabId: string;
    request: TerminalCommandRequest;
  } | null>(null);

  const activeRuntime = tabRuntime[terminalTabs.activeTabId];
  const activeCwd = activeRuntime?.session?.cwd || activeProjectPath || "未绑定项目目录";
  const visibleTabs = useMemo(() => {
    const activeIndex = terminalTabs.tabs.findIndex((tab) => tab.id === terminalTabs.activeTabId);
    if (activeIndex < 0) return terminalTabs.tabs.slice(0, activeLayout.visibleCount);

    const pageStart =
      Math.floor(activeIndex / activeLayout.visibleCount) * activeLayout.visibleCount;
    return terminalTabs.tabs.slice(pageStart, pageStart + activeLayout.visibleCount);
  }, [activeLayout.visibleCount, terminalTabs.activeTabId, terminalTabs.tabs]);
  const visibleTabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs]);

  function fitVisibleTerminals() {
    visibleTabs.forEach((tab) => terminalHandlesRef.current[tab.id]?.fit());
  }

  function clearTerminalFitTimers() {
    if (terminalFitFrameRef.current) {
      window.cancelAnimationFrame(terminalFitFrameRef.current);
      terminalFitFrameRef.current = null;
    }
    terminalFitSettleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    terminalFitSettleTimersRef.current = [];
  }

  function scheduleVisibleTerminalFit(withSettle = false) {
    if (terminalFitFrameRef.current) {
      window.cancelAnimationFrame(terminalFitFrameRef.current);
    }

    terminalFitFrameRef.current = window.requestAnimationFrame(() => {
      terminalFitFrameRef.current = null;
      fitVisibleTerminals();
    });

    if (!withSettle) return;

    terminalFitSettleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    terminalFitSettleTimersRef.current = [80, 180, 320].map((delay) =>
      window.setTimeout(fitVisibleTerminals, delay),
    );
  }

  function resetLayoutWeights() {
    setColumnWeights(createEqualWeights(activeLayout.columns));
    setRowWeights(createEqualWeights(activeLayout.rows));
    scheduleVisibleTerminalFit(true);
  }

  function startLayoutResize(
    axis: ResizeAxis,
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDragRef.current = {
      axis,
      index,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSizes: axis === "column" ? columnWeights : rowWeights,
    };
    setIsResizingLayout(true);
  }

  function updateLayoutResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeDragRef.current;
    const surface = terminalSurfaceRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !surface) return;

    event.preventDefault();
    const rect = surface.getBoundingClientRect();
    if (drag.axis === "column") {
      const delta = event.clientX - drag.startClientX;
      setColumnWeights(resizeAdjacentWeights(drag.startSizes, drag.index, delta, rect.width));
    } else {
      const delta = event.clientY - drag.startClientY;
      setRowWeights(resizeAdjacentWeights(drag.startSizes, drag.index, delta, rect.height));
    }
    scheduleVisibleTerminalFit();
  }

  function finishLayoutResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released when the window loses focus.
    }
    resizeDragRef.current = null;
    setIsResizingLayout(false);
    scheduleVisibleTerminalFit(true);
  }

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
    resetLayoutWeights();
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
    scheduleVisibleTerminalFit(true);
  }, [layoutMode, visibleTabs]);

  useEffect(() => {
    setColumnWeights(createEqualWeights(activeLayout.columns));
    setRowWeights(createEqualWeights(activeLayout.rows));
    scheduleVisibleTerminalFit(true);
  }, [activeLayout.columns, activeLayout.rows]);

  useEffect(() => () => clearTerminalFitTimers(), []);

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
              return (
                <button
                  key={layout.mode}
                  className={`terminal-layout-button ${layoutMode === layout.mode ? "active" : ""}`}
                  title={layout.title}
                  onClick={() => changeLayoutMode(layout.mode)}
                >
                  <Grid2X2 size={13} />
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

      <div
        className={`terminal-surface ${isResizingLayout ? "resizing" : ""}`}
        ref={terminalSurfaceRef}
        style={{
          gridTemplateColumns: formatGridWeights(columnWeights),
          gridTemplateRows: formatGridWeights(rowWeights),
        } as CSSProperties}
      >
        {terminalTabs.tabs.map((tab) => (
          <div
            className={`terminal-cell ${tab.id === terminalTabs.activeTabId ? "active" : ""} ${
              visibleTabIds.has(tab.id) ? "visible" : ""
            }`}
            key={tab.id}
            onMouseDown={() => focusTerminal(tab.id)}
          >
            <div className="terminal-cell-header">
              <span className="terminal-cell-title">
                <span
                  className={`terminal-cell-status ${
                    tabRuntime[tab.id]?.isStarting
                      ? "starting"
                      : tabRuntime[tab.id]?.session
                        ? "running"
                        : "stopped"
                  }`}
                />
                {tab.title}
              </span>
              <span className="terminal-cell-path">
                {formatTerminalPath(tabRuntime[tab.id]?.session?.cwd || activeProjectPath)}
              </span>
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
        {activeLayout.columns > 1 &&
          columnWeights.slice(0, -1).map((_, index) => (
            <div
              aria-label="调整终端列宽"
              aria-orientation="vertical"
              className="terminal-resize-handle column"
              key={`column-${index}`}
              role="separator"
              style={{
                left: `calc(10px + (100% - 20px) * ${getResizeBoundaryPercent(columnWeights, index) / 100})`,
              }}
              title="拖动调整列宽，双击重置"
              onDoubleClick={resetLayoutWeights}
              onPointerCancel={finishLayoutResize}
              onPointerDown={(event) => startLayoutResize("column", index, event)}
              onPointerMove={updateLayoutResize}
              onPointerUp={finishLayoutResize}
            />
          ))}
        {activeLayout.rows > 1 &&
          rowWeights.slice(0, -1).map((_, index) => (
            <div
              aria-label="调整终端行高"
              aria-orientation="horizontal"
              className="terminal-resize-handle row"
              key={`row-${index}`}
              role="separator"
              style={{
                top: `calc(10px + (100% - 20px) * ${getResizeBoundaryPercent(rowWeights, index) / 100})`,
              }}
              title="拖动调整行高，双击重置"
              onDoubleClick={resetLayoutWeights}
              onPointerCancel={finishLayoutResize}
              onPointerDown={(event) => startLayoutResize("row", index, event)}
              onPointerMove={updateLayoutResize}
              onPointerUp={finishLayoutResize}
            />
          ))}
      </div>
    </section>
  );
}
