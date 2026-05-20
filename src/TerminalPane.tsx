import {
  Ban,
  PanelTop,
  Plus,
  RotateCcw,
  SendHorizontal,
  Square,
  SquareStack,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  TerminalSessionView,
  type TerminalSessionHandle,
  type TerminalSessionRuntime,
} from "./TerminalSessionView";
import { formatPastedImagePath, getClipboardImageItem, saveClipboardImage } from "./clipboardImages";
import type { TerminalAppearanceSettings, TerminalCommandRequest } from "./types";

interface TerminalPaneProps {
  activeProjectId?: string | null;
  activeProjectName?: string | null;
  activeProjectPath?: string | null;
  appearance: TerminalAppearanceSettings;
  commandRequest?: TerminalCommandRequest | null;
  onError: (message: string) => void;
  onProjectFocus?: (projectId: string) => void | Promise<void>;
}

interface TerminalProjectBinding {
  id?: string | null;
  name?: string | null;
  path?: string | null;
}

interface TerminalTab {
  id: string;
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  title: string;
}

interface TerminalTabsState {
  tabs: TerminalTab[];
  activeTabId: string;
}

type TerminalDisplayMode = "tabs" | "tiles";
type TerminalDockZone = "top" | "right" | "bottom" | "left" | "center";
type TerminalFocusTarget = "composer" | "terminal" | "none";
type ResizeAxis = "column" | "row";
type ComposerTerminalNavigationKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "PageUp"
  | "PageDown"
  | "Home"
  | "End"
  | "Enter";

interface ResizeDragState {
  axis: ResizeAxis;
  index: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSizes: number[];
}

interface TerminalTileDragState {
  tabId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  dragging: boolean;
  target: TerminalDockTarget | null;
}

interface TerminalDockTarget {
  tabId: string;
  zone: TerminalDockZone;
}

type TerminalRuntimeStatus = "starting" | "running" | "stopped";

const composerTerminalNavigationInput: Record<ComposerTerminalNavigationKey, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Home: "\x1b[H",
  End: "\x1b[F",
  Enter: "\r",
};

type TerminalTileArrangement =
  | { kind: "auto" }
  | { kind: "columns" }
  | { kind: "rows" }
  | { kind: "rowSplit"; bottomTabIds: string[] }
  | {
      kind: "columnStack";
      anchorTabId: string;
      dockedTabId: string;
      dockedBefore: boolean;
      stackColumn: "left" | "right";
    };

interface TerminalLayoutPreferences {
  displayMode: TerminalDisplayMode;
  tileArrangement: TerminalTileArrangement;
}

interface TerminalGridLayout {
  displayMode: TerminalDisplayMode;
  tileArrangement: TerminalTileArrangement;
  rows: number;
  columns: number;
  visibleCount: number;
}

const terminalLayoutStorageKey = "opencode-workbench.terminal-layout";
const maxVisibleTerminals = 9;
const defaultLayoutPreferences: TerminalLayoutPreferences = {
  displayMode: "tiles",
  tileArrangement: { kind: "auto" },
};
const tileDragActivationDistance = 16;
const surfaceDockEdgeRatio = 0.14;
const tileDockEdgeRatio = 0.22;
const bottomRowJoinRatio = 0.5;
const dockZoneLabels: Record<TerminalDockZone, string> = {
  top: "停靠到上方",
  right: "停靠到右侧",
  bottom: "停靠到下方",
  left: "停靠到左侧",
  center: "移到此处",
};
const surfaceDockTargetId = "__surface__";

function projectTitle(name?: string | null, index?: number) {
  const trimmedName = name?.trim();
  if (!trimmedName) return `终端 ${index ?? 1}`;
  return index && index > 1 ? `${trimmedName} · ${index}` : trimmedName;
}

function createTerminalTab(index: number, project?: TerminalProjectBinding): TerminalTab {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  const projectName = project?.name?.trim() || null;

  return {
    id,
    projectId: project?.id || null,
    projectName,
    projectPath: project?.path || null,
    title: projectTitle(projectName, index),
  };
}

function bindTerminalTab(tab: TerminalTab, index: number, project: TerminalProjectBinding): TerminalTab {
  const projectName = project.name?.trim() || null;

  return {
    ...tab,
    projectId: project.id || null,
    projectName,
    projectPath: project.path || null,
    title: projectTitle(projectName, index),
  };
}

function createInitialTabs(project?: TerminalProjectBinding): TerminalTabsState {
  const tab = createTerminalTab(1, project);
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

function getTerminalRuntimeStatus(runtime?: TerminalSessionRuntime): {
  status: TerminalRuntimeStatus;
  label: string;
} {
  if (runtime?.isStarting) return { status: "starting", label: "启动中" };
  if (runtime?.session) return { status: "running", label: "运行中" };
  return { status: "stopped", label: "已停止" };
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

function clampVisibleCount(tabCount: number) {
  return Math.max(1, Math.min(maxVisibleTerminals, tabCount));
}

function readStoredLayoutPreferences(): TerminalLayoutPreferences {
  try {
    const raw = window.localStorage.getItem(terminalLayoutStorageKey);
    if (!raw) return defaultLayoutPreferences;

    const parsed = JSON.parse(raw) as Partial<TerminalLayoutPreferences> | null;
    const displayMode = parsed?.displayMode === "tabs" ? "tabs" : "tiles";
    return { ...defaultLayoutPreferences, displayMode };
  } catch {
    return defaultLayoutPreferences;
  }
}

function cacheLayoutPreferences(preferences: TerminalLayoutPreferences) {
  window.localStorage.setItem(
    terminalLayoutStorageKey,
    JSON.stringify({ displayMode: preferences.displayMode }),
  );
}

function getGridLayout(preferences: TerminalLayoutPreferences, tabCount: number): TerminalGridLayout {
  const visibleCount = preferences.displayMode === "tabs" ? 1 : clampVisibleCount(tabCount);

  if (preferences.displayMode === "tabs" || visibleCount === 1) {
    return {
      ...preferences,
      rows: 1,
      columns: 1,
      visibleCount,
    };
  }

  if (preferences.tileArrangement.kind === "rows") {
    return {
      ...preferences,
      rows: visibleCount,
      columns: 1,
      visibleCount,
    };
  }

  if (preferences.tileArrangement.kind === "columnStack" && visibleCount >= 3) {
    return {
      ...preferences,
      rows: 2,
      columns: visibleCount - 1,
      visibleCount,
    };
  }

  if (preferences.tileArrangement.kind === "rowSplit" && visibleCount >= 3) {
    const bottomCount = Math.min(visibleCount - 1, Math.max(1, preferences.tileArrangement.bottomTabIds.length));
    return {
      ...preferences,
      rows: 2,
      columns: Math.max(visibleCount - bottomCount, bottomCount),
      visibleCount,
    };
  }

  if (preferences.tileArrangement.kind === "auto" && visibleCount >= 4) {
    const columns = Math.ceil(Math.sqrt(visibleCount));
    const rows = Math.ceil(visibleCount / columns);
    return {
      ...preferences,
      rows,
      columns,
      visibleCount,
    };
  }

  return {
    ...preferences,
    rows: 1,
    columns: visibleCount,
    visibleCount,
  };
}

function getGridCellStyle(
  tabId: string,
  visibleTabs: TerminalTab[],
  layout: TerminalGridLayout,
): CSSProperties | undefined {
  if (layout.displayMode !== "tiles") {
    return undefined;
  }

  if (layout.tileArrangement.kind === "rowSplit") {
    const bottomTabIdSet = new Set(layout.tileArrangement.bottomTabIds);
    const visibleBottomTabs = visibleTabs.filter((tab) => bottomTabIdSet.has(tab.id));
    if (layout.visibleCount < 3 || visibleBottomTabs.length === 0) {
      return undefined;
    }

    const bottomTabs = visibleBottomTabs.length >= layout.visibleCount ? [visibleBottomTabs[0]] : visibleBottomTabs;
    const topTabs = visibleTabs.filter((tab) => !bottomTabs.some((bottomTab) => bottomTab.id === tab.id));
    const isBottomTab = bottomTabs.some((tab) => tab.id === tabId);
    const rowTabs = isBottomTab ? bottomTabs : topTabs;
    const index = rowTabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return undefined;

    const span = Math.max(1, Math.floor(layout.columns / rowTabs.length));
    const start = index * span + 1;
    const end = index === rowTabs.length - 1 ? -1 : start + span;
    return {
      gridColumn: end === -1 ? `${start} / -1` : `${start} / ${end}`,
      gridRow: isBottomTab ? "2" : "1",
    };
  }

  if (layout.tileArrangement.kind !== "columnStack") {
    return undefined;
  }

  const { anchorTabId, dockedTabId, dockedBefore, stackColumn } = layout.tileArrangement;
  if (
    layout.visibleCount < 3 ||
    !visibleTabs.some((tab) => tab.id === anchorTabId) ||
    !visibleTabs.some((tab) => tab.id === dockedTabId)
  ) {
    return undefined;
  }

  if (tabId === anchorTabId || tabId === dockedTabId) {
    const column = stackColumn === "left" ? 1 : layout.columns;
    const row = tabId === dockedTabId ? (dockedBefore ? 1 : 2) : dockedBefore ? 2 : 1;
    return {
      gridColumn: String(column),
      gridRow: String(row),
    };
  }

  const fillerTabs = visibleTabs.filter((tab) => tab.id !== anchorTabId && tab.id !== dockedTabId);
  const fillerIndex = fillerTabs.findIndex((tab) => tab.id === tabId);
  if (fillerIndex < 0) return undefined;

  const column = stackColumn === "left" ? fillerIndex + 2 : fillerIndex + 1;
  return {
    gridColumn: String(column),
    gridRow: "1 / -1",
  };
}

export function TerminalPane({
  activeProjectId,
  activeProjectName,
  activeProjectPath,
  appearance,
  commandRequest,
  onError,
  onProjectFocus,
}: TerminalPaneProps) {
  const nextTabIndexRef = useRef(2);
  const terminalHandlesRef = useRef<Record<string, TerminalSessionHandle | undefined>>({});
  const terminalTabsRef = useRef<HTMLDivElement | null>(null);
  const terminalTabElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const terminalSurfaceRef = useRef<HTMLDivElement | null>(null);
  const terminalFitFrameRef = useRef<number | null>(null);
  const terminalFitSettleTimersRef = useRef<number[]>([]);
  const resizeDragRef = useRef<ResizeDragState | null>(null);
  const tileDragRef = useRef<TerminalTileDragState | null>(null);
  const lastRoutedCommandIdRef = useRef<number | null>(null);
  const previousProjectIdRef = useRef(activeProjectId);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTabsState>(() =>
    createInitialTabs({ id: activeProjectId, name: activeProjectName, path: activeProjectPath }),
  );
  const [layoutPreferences, setLayoutPreferences] = useState<TerminalLayoutPreferences>(readStoredLayoutPreferences);
  const activeLayout = useMemo(
    () => getGridLayout(layoutPreferences, terminalTabs.tabs.length),
    [layoutPreferences, terminalTabs.tabs.length],
  );
  const [columnWeights, setColumnWeights] = useState(() => createEqualWeights(activeLayout.columns));
  const [rowWeights, setRowWeights] = useState(() => createEqualWeights(activeLayout.rows));
  const [isResizingLayout, setIsResizingLayout] = useState(false);
  const [isDraggingTile, setIsDraggingTile] = useState(false);
  const [dockTarget, setDockTarget] = useState<TerminalDockTarget | null>(null);
  const [tabRuntime, setTabRuntime] = useState<Record<string, TerminalSessionRuntime>>({});
  const [routedCommand, setRoutedCommand] = useState<{
    tabId: string;
    request: TerminalCommandRequest;
  } | null>(null);
  const [composerInputValue, setComposerInputValue] = useState("");
  const activeProjectBinding = useMemo(
    () => ({
      id: activeProjectId || null,
      name: activeProjectName || null,
      path: activeProjectPath || null,
    }),
    [activeProjectId, activeProjectName, activeProjectPath],
  );

  const activeRuntime = tabRuntime[terminalTabs.activeTabId];
  const hasComposerText = Boolean(composerInputValue.trim());
  const visibleTabs = useMemo(() => {
    if (activeLayout.displayMode === "tabs") {
      const activeTab = terminalTabs.tabs.find((tab) => tab.id === terminalTabs.activeTabId);
      return activeTab ? [activeTab] : terminalTabs.tabs.slice(0, 1);
    }

    const activeIndex = terminalTabs.tabs.findIndex((tab) => tab.id === terminalTabs.activeTabId);
    if (activeIndex < 0) return terminalTabs.tabs.slice(0, activeLayout.visibleCount);

    const pageStart =
      Math.floor(activeIndex / activeLayout.visibleCount) * activeLayout.visibleCount;
    return terminalTabs.tabs.slice(pageStart, pageStart + activeLayout.visibleCount);
  }, [activeLayout.displayMode, activeLayout.visibleCount, terminalTabs.activeTabId, terminalTabs.tabs]);
  const visibleTabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs]);

  function updateLayoutPreferences(nextPreferences: TerminalLayoutPreferences) {
    setLayoutPreferences(nextPreferences);
    focusComposer();
  }

  function focusComposer() {
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }

  function focusActiveTerminal() {
    const activeTerminal = terminalHandlesRef.current[terminalTabs.activeTabId];
    window.setTimeout(() => activeTerminal?.focus(), 0);
  }

  function submitComposerInput() {
    const value = composerInputValue.trimEnd();
    if (!value) return;

    const activeTerminal = terminalHandlesRef.current[terminalTabs.activeTabId];
    if (!activeTerminal) return;

    activeTerminal.sendComposerInput(value);
    setComposerInputValue("");
    focusActiveTerminal();
  }

  function sendComposerNavigationKeyToTerminal(key: string) {
    if (composerInputValue.trim()) return false;
    if (!(key in composerTerminalNavigationInput)) return false;

    const activeTerminal = terminalHandlesRef.current[terminalTabs.activeTabId];
    if (!activeTerminal) return false;

    activeTerminal.sendRawInput(composerTerminalNavigationInput[key as ComposerTerminalNavigationKey]);
    return true;
  }

  function handleComposerInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (composerInputValue) {
        setComposerInputValue("");
      } else {
        focusActiveTerminal();
      }
      return;
    }

    if (event.key.toLowerCase() === "c" && event.ctrlKey && !event.shiftKey && !event.altKey) {
      const target = event.currentTarget;
      const hasSelection = target.selectionStart !== target.selectionEnd;
      if (!hasSelection) {
        event.preventDefault();
        terminalHandlesRef.current[terminalTabs.activeTabId]?.interrupt();
      }
      return;
    }

    if (
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      sendComposerNavigationKeyToTerminal(event.key)
    ) {
      event.preventDefault();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitComposerInput();
    }
  }

  function insertComposerText(text: string, target?: HTMLTextAreaElement | null) {
    if (!text) return;

    const input = target ?? composerInputRef.current;
    const selectionStart = input?.selectionStart ?? composerInputValue.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const nextValue =
      composerInputValue.slice(0, selectionStart) + text + composerInputValue.slice(selectionEnd);
    const nextCursor = selectionStart + text.length;

    setComposerInputValue(nextValue);
    window.setTimeout(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const imageItem = getClipboardImageItem(event.clipboardData);
    if (!imageItem) return;

    event.preventDefault();
    event.stopPropagation();
    const input = event.currentTarget;
    void saveClipboardImage(imageItem)
      .then((path) => {
        if (path) insertComposerText(formatPastedImagePath(path), input);
      })
      .catch((error) => onError(String(error)));
  }

  function interruptActiveTerminal() {
    terminalHandlesRef.current[terminalTabs.activeTabId]?.interrupt();
    focusActiveTerminal();
  }

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

  function getDockTarget(clientX: number, clientY: number, draggedTabId: string): TerminalDockTarget | null {
    const surface = terminalSurfaceRef.current;
    if (surface && activeLayout.displayMode === "tiles" && activeLayout.visibleCount >= 3) {
      const surfaceRect = surface.getBoundingClientRect();
      const isInsideSurface =
        clientX >= surfaceRect.left &&
        clientX <= surfaceRect.right &&
        clientY >= surfaceRect.top &&
        clientY <= surfaceRect.bottom;
      if (isInsideSurface) {
        const yRatio = (clientY - surfaceRect.top) / Math.max(1, surfaceRect.height);
        if (yRatio < surfaceDockEdgeRatio) return { tabId: surfaceDockTargetId, zone: "top" };
        if (yRatio > 1 - surfaceDockEdgeRatio) return { tabId: surfaceDockTargetId, zone: "bottom" };
      }
    }

    const elements = Array.from(
      surface?.querySelectorAll<HTMLElement>(".terminal-cell.visible[data-tab-id]") ?? [],
    );

    for (const element of elements) {
      const tabId = element.dataset.tabId;
      if (!tabId || tabId === draggedTabId) continue;

      const rect = element.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        continue;
      }

      const xRatio = (clientX - rect.left) / Math.max(1, rect.width);
      const yRatio = (clientY - rect.top) / Math.max(1, rect.height);
      if (
        activeLayout.tileArrangement.kind === "rowSplit" &&
        activeLayout.tileArrangement.bottomTabIds.includes(tabId) &&
        yRatio > bottomRowJoinRatio
      ) {
        return { tabId: surfaceDockTargetId, zone: "bottom" };
      }

      if (yRatio < tileDockEdgeRatio) return { tabId, zone: "top" };
      if (yRatio > 1 - tileDockEdgeRatio) return { tabId, zone: "bottom" };
      if (xRatio < tileDockEdgeRatio) return { tabId, zone: "left" };
      if (xRatio > 1 - tileDockEdgeRatio) return { tabId, zone: "right" };
      return { tabId, zone: "center" };
    }

    return null;
  }

  function reorderTabsForDock(current: TerminalTab[], draggedTabId: string, target: TerminalDockTarget) {
    if (draggedTabId === target.tabId) return current;

    const draggedIndex = current.findIndex((tab) => tab.id === draggedTabId);
    if (draggedIndex < 0) return current;

    const tabs = [...current];
    const [draggedTab] = tabs.splice(draggedIndex, 1);
    if (target.tabId === surfaceDockTargetId) {
      const insertIndex = target.zone === "top" ? 0 : tabs.length;
      tabs.splice(insertIndex, 0, draggedTab);
      return tabs;
    }

    if (!tabs.some((tab) => tab.id === target.tabId)) return current;

    const nextTargetIndex = tabs.findIndex((tab) => tab.id === target.tabId);
    const insertIndex = target.zone === "right" || target.zone === "bottom" ? nextTargetIndex + 1 : nextTargetIndex;
    tabs.splice(insertIndex, 0, draggedTab);
    return tabs;
  }

  function getArrangementForDock(draggedTabId: string, target: TerminalDockTarget): TerminalTileArrangement {
    if (target.tabId === surfaceDockTargetId && (target.zone === "top" || target.zone === "bottom")) {
      if (target.zone === "top") {
        return {
          kind: "rowSplit",
          bottomTabIds: terminalTabs.tabs
            .filter((tab) => tab.id !== draggedTabId)
            .map((tab) => tab.id),
        };
      }

      const currentArrangement = layoutPreferences.tileArrangement;
      const currentBottomTabIds =
        currentArrangement.kind === "rowSplit" ? currentArrangement.bottomTabIds : [];
      const maxBottomCount = Math.max(1, Math.min(maxVisibleTerminals, terminalTabs.tabs.length) - 1);
      const bottomTabIds = [
        ...currentBottomTabIds.filter((tabId) => tabId !== draggedTabId),
        draggedTabId,
      ].slice(-maxBottomCount);
      return { kind: "rowSplit", bottomTabIds };
    }

    if (target.zone === "top" || target.zone === "bottom") {
      return {
        kind: "columnStack",
        anchorTabId: target.tabId,
        dockedTabId: draggedTabId,
        dockedBefore: target.zone === "top",
        stackColumn: "right",
      };
    }

    if (target.zone === "center") {
      return { kind: "auto" };
    }

    return { kind: "columns" };
  }

  function applyDockTarget(draggedTabId: string, target: TerminalDockTarget) {
    setTerminalTabs((current) => ({
      tabs: reorderTabsForDock(current.tabs, draggedTabId, target),
      activeTabId: draggedTabId,
    }));
    setLayoutPreferences((current) => ({
      ...current,
      displayMode: "tiles",
      tileArrangement: getArrangementForDock(draggedTabId, target),
    }));
    window.setTimeout(() => scheduleVisibleTerminalFit(true), 0);
  }

  function startTileDrag(tabId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || layoutPreferences.displayMode !== "tiles" || terminalTabs.tabs.length <= 1) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    tileDragRef.current = {
      tabId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      dragging: false,
      target: null,
    };
  }

  function updateTileDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = tileDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    const deltaX = Math.abs(event.clientX - drag.startClientX);
    const deltaY = Math.abs(event.clientY - drag.startClientY);
    if (!drag.dragging && Math.max(deltaX, deltaY) < tileDragActivationDistance) return;

    const target = getDockTarget(event.clientX, event.clientY, drag.tabId);
    const nextDragging = true;
    if (drag.dragging && drag.target?.tabId === target?.tabId && drag.target?.zone === target?.zone) {
      return;
    }

    tileDragRef.current = {
      ...drag,
      dragging: nextDragging,
      target,
    };
    if (!drag.dragging) {
      setIsDraggingTile(true);
    }
    setDockTarget(target);
  }

  function finishTileDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = tileDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released when the window loses focus.
    }

    tileDragRef.current = null;
    setIsDraggingTile(false);
    setDockTarget(null);
    if (drag.dragging && drag.target) {
      applyDockTarget(drag.tabId, drag.target);
      return;
    }
    focusTerminal(drag.tabId, "terminal");
  }

  const updateRuntime = useCallback((tabId: string, runtime: TerminalSessionRuntime) => {
    setTabRuntime((current) => ({
      ...current,
      [tabId]: runtime,
    }));
  }, []);

  useEffect(() => {
    cacheLayoutPreferences(layoutPreferences);
  }, [layoutPreferences]);

  useEffect(() => {
    if (previousProjectIdRef.current === activeProjectId) return;

    previousProjectIdRef.current = activeProjectId;
    setRoutedCommand(null);

    setTerminalTabs((current) => {
      if (!activeProjectId) return current;

      const existingTab = current.tabs.find((tab) => tab.projectId === activeProjectId);
      if (existingTab) {
        return {
          ...current,
          activeTabId: existingTab.id,
        };
      }

      const activeTab = current.tabs.find((tab) => tab.id === current.activeTabId);
      if (activeTab && !activeTab.projectId) {
        const activeTabIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
        const tabs = current.tabs.map((tab, index) =>
          tab.id === current.activeTabId ? bindTerminalTab(tab, index + 1, activeProjectBinding) : tab,
        );
        return {
          tabs,
          activeTabId: tabs[activeTabIndex].id,
        };
      }

      const tab = createTerminalTab(nextTabIndexRef.current, activeProjectBinding);
      nextTabIndexRef.current += 1;
      return {
        tabs: [...current.tabs, tab],
        activeTabId: tab.id,
      };
    });
  }, [activeProjectBinding, activeProjectId]);

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
  }, [layoutPreferences, visibleTabs]);

  useEffect(() => {
    setColumnWeights(createEqualWeights(activeLayout.columns));
    setRowWeights(createEqualWeights(activeLayout.rows));
    scheduleVisibleTerminalFit(true);
  }, [activeLayout.columns, activeLayout.rows]);

  useEffect(() => () => clearTerminalFitTimers(), []);

  function addTerminalTab() {
    const tab = createTerminalTab(nextTabIndexRef.current, activeProjectBinding);
    nextTabIndexRef.current += 1;

    setTerminalTabs((current) => ({
      tabs: [...current.tabs, tab],
      activeTabId: tab.id,
    }));
    focusComposer();
  }

  function closeTerminalTab(tabId: string) {
    const closingIndex = terminalTabs.tabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;

    void terminalHandlesRef.current[tabId]?.stopSession();
    setTabRuntime((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setRoutedCommand((current) => (current?.tabId === tabId ? null : current));

    if (terminalTabs.tabs.length <= 1) {
      if (terminalTabs.activeTabId === tabId) {
        focusComposer();
      }
      return;
    }

    const isClosingActiveTab = terminalTabs.activeTabId === tabId;
    const tabs = terminalTabs.tabs.filter((tab) => tab.id !== tabId);
    const fallbackTab = tabs[Math.max(0, closingIndex - 1)] ?? tabs[0];
    const activeTabId = isClosingActiveTab ? fallbackTab.id : terminalTabs.activeTabId;

    setTerminalTabs({ tabs, activeTabId });
    if (isClosingActiveTab && fallbackTab.projectId && fallbackTab.projectId !== activeProjectId) {
      void onProjectFocus?.(fallbackTab.projectId);
    }

    window.setTimeout(() => scheduleVisibleTerminalFit(true), 0);
  }

  function restartActiveTerminal() {
    void terminalHandlesRef.current[terminalTabs.activeTabId]?.restartSession();
  }

  function stopActiveTerminal() {
    void terminalHandlesRef.current[terminalTabs.activeTabId]?.stopSession();
  }

  function focusTerminal(tabId: string, target: TerminalFocusTarget = "terminal") {
    const tab = terminalTabs.tabs.find((item) => item.id === tabId);
    setTerminalTabs((current) => ({
      ...current,
      activeTabId: tabId,
    }));
    if (tab?.projectId && tab.projectId !== activeProjectId) {
      onProjectFocus?.(tab.projectId);
    }

    if (target === "composer") {
      focusComposer();
      return;
    }

    if (target === "terminal") {
      window.setTimeout(() => terminalHandlesRef.current[tabId]?.focus(), 0);
    }
  }

  return (
    <section className="terminal-pane">
      <header className="terminal-bar">
        <div className="terminal-tab-strip">
          <strong className="terminal-bar-title">终端瓦片</strong>
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
              const { status } = getTerminalRuntimeStatus(runtime);

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
                    title={runtime?.session?.cwd || tab.projectPath || tab.title}
                    onClick={() => focusTerminal(tab.id)}
                  >
                    <span className={`terminal-tab-dot ${status}`} />
                    <span>{tab.title}</span>
                  </button>
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
                </div>
              );
            })}
          </div>
          <button className="terminal-tab-add" title="新建终端" onClick={addTerminalTab}>
            <Plus size={14} />
          </button>
        </div>

        <div className="terminal-actions">
          <div className="terminal-layout-switch" aria-label="终端显示方式">
            <button
              className={`terminal-layout-button ${layoutPreferences.displayMode === "tabs" ? "active" : ""}`}
              title="单 Tab 显示"
              onClick={() => updateLayoutPreferences({ ...layoutPreferences, displayMode: "tabs" })}
            >
              <PanelTop size={13} />
              <span>单 Tab</span>
            </button>
            <button
              className={`terminal-layout-button ${layoutPreferences.displayMode === "tiles" ? "active" : ""}`}
              title="多瓦片显示"
              onClick={() => updateLayoutPreferences({ ...layoutPreferences, displayMode: "tiles" })}
            >
              <SquareStack size={13} />
              <span>多瓦片</span>
            </button>
          </div>
          <button
            className="terminal-action"
            title="中止当前终端"
            disabled={!activeRuntime?.session}
            onClick={interruptActiveTerminal}
          >
            <Ban size={14} />
            中止
          </button>
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
        className={`terminal-surface ${isResizingLayout ? "resizing" : ""} ${isDraggingTile ? "tile-dragging" : ""}`}
        ref={terminalSurfaceRef}
        style={{
          gridTemplateColumns: formatGridWeights(columnWeights),
          gridTemplateRows: formatGridWeights(rowWeights),
        } as CSSProperties}
      >
        {terminalTabs.tabs.map((tab) => {
          const runtime = tabRuntime[tab.id];
          const { status, label } = getTerminalRuntimeStatus(runtime);
          const cwd = runtime?.session?.cwd || tab.projectPath;
          const tabDockTarget = dockTarget?.tabId === tab.id ? dockTarget : null;
          const shouldShowDockCue = Boolean(tabDockTarget && tabDockTarget.zone !== "center");

          return (
            <div
              className={`terminal-cell ${tab.id === terminalTabs.activeTabId ? "active" : ""} ${
                visibleTabIds.has(tab.id) ? "visible" : ""
              } ${tileDragRef.current?.tabId === tab.id ? "dragging" : ""} ${
                shouldShowDockCue ? `dock-target dock-${tabDockTarget?.zone}` : ""
              }`}
              data-tab-id={tab.id}
              key={tab.id}
              style={getGridCellStyle(tab.id, visibleTabs, activeLayout)}
              onMouseDown={() => focusTerminal(tab.id)}
            >
              <div
                className="terminal-cell-header"
                title="拖动调整瓦片位置"
                onMouseDown={(event) => event.stopPropagation()}
                onPointerCancel={finishTileDrag}
                onPointerDown={(event) => startTileDrag(tab.id, event)}
                onPointerMove={updateTileDrag}
                onPointerUp={finishTileDrag}
              >
                <span className="terminal-cell-meta">
                  <span className="terminal-cell-title">
                    <span className={`terminal-cell-status ${status}`} />
                    <span>{tab.title}</span>
                  </span>
                  {status !== "stopped" && (
                    <span className={`terminal-cell-state ${status}`}>{label}</span>
                  )}
                </span>
                <span className="terminal-cell-path" title={cwd || "未绑定项目目录"}>
                  {formatTerminalPath(cwd)}
                </span>
                <button
                  className="terminal-cell-close"
                  title="关闭此终端"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTerminalTab(tab.id);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <X size={12} />
                </button>
                {shouldShowDockCue && tabDockTarget && (
                  <span className="terminal-dock-hint">{dockZoneLabels[tabDockTarget.zone]}</span>
                )}
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
                activeProjectId={tab.projectId || null}
                appearance={appearance}
                commandRequest={routedCommand?.tabId === tab.id ? routedCommand.request : null}
                onError={onError}
                onRuntimeChange={updateRuntime}
              />
            </div>
          );
        })}
        {dockTarget?.tabId === surfaceDockTargetId && (
          <div className={`terminal-surface-dock-preview ${dockTarget.zone}`}>
            {dockZoneLabels[dockTarget.zone]}
          </div>
        )}
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

      <form
        className="terminal-composer"
        aria-label="对话输入"
        onSubmit={(event) => {
          event.preventDefault();
          submitComposerInput();
        }}
      >
        <textarea
          ref={composerInputRef}
          className="terminal-composer-input"
          aria-label="输入内容"
          placeholder="输入给当前会话"
          rows={2}
          value={composerInputValue}
          onChange={(event) => setComposerInputValue(event.target.value)}
          onKeyDownCapture={handleComposerInputKeyDown}
          onKeyDown={handleComposerInputKeyDown}
          onPaste={handleComposerPaste}
        />
        <button
          className="terminal-composer-send"
          disabled={!hasComposerText}
          title="发送"
          type="submit"
        >
          <SendHorizontal size={16} />
        </button>
      </form>
    </section>
  );
}
