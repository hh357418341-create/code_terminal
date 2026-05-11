import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  GripVertical,
  ExternalLink,
  FolderOpen,
  Minus,
  Palette,
  PanelsTopLeft,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TerminalPane } from "./TerminalPane";
import {
  clampTerminalFontSize,
  clampTerminalLineHeight,
  defaultTerminalAppearance,
  getTerminalChrome,
  getTerminalPresetAppearance,
  normalizeTerminalAppearance,
  terminalThemePresetOrder,
  terminalThemePresets,
} from "./terminalThemes";
import type {
  BuiltInTerminalThemePreset,
  TerminalAppearanceSettings,
  TerminalColorKey,
  WorkbenchState,
} from "./types";
import type { CSSProperties } from "react";

const emptyState: WorkbenchState = {
  projects: [],
  activeProjectId: null,
};
const emptyProjectTitle = "未选择项目";
const appearanceStorageKey = "opencode-workbench.terminal-appearance";
const colorFields: Array<{ key: TerminalColorKey; label: string }> = [
  { key: "background", label: "背景" },
  { key: "foreground", label: "文字" },
  { key: "cursor", label: "光标" },
];
const customThemeLabel = "自定义";
type ProjectDropPlacement = "before" | "after";

function readStoredTerminalAppearance(): TerminalAppearanceSettings {
  try {
    const raw = window.localStorage.getItem(appearanceStorageKey);
    if (!raw) return normalizeTerminalAppearance();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return normalizeTerminalAppearance();
    return normalizeTerminalAppearance(parsed as Partial<TerminalAppearanceSettings>);
  } catch {
    return normalizeTerminalAppearance();
  }
}

function cacheTerminalAppearance(appearance: TerminalAppearanceSettings) {
  window.localStorage.setItem(appearanceStorageKey, JSON.stringify(appearance));
}

function getWindowProjectId() {
  try {
    return new URLSearchParams(window.location.search).get("projectId");
  } catch {
    return null;
  }
}

function formatRelativeTime(value: number) {
  if (!value) return "";

  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - value);
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;

  const months = Math.floor(days / 30);
  return `${months} 月`;
}

export function App() {
  const [windowProjectId, setWindowProjectId] = useState<string | null>(() => getWindowProjectId());
  const [state, setState] = useState<WorkbenchState>(emptyState);
  const [error, setError] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{
    id: string;
    placement: ProjectDropPlacement;
  } | null>(null);
  const [openingProjectWindowId, setOpeningProjectWindowId] = useState<string | null>(null);
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearanceSettings>(
    readStoredTerminalAppearance,
  );
  const [customTerminalAppearance, setCustomTerminalAppearance] = useState<TerminalAppearanceSettings>(() =>
    normalizeTerminalAppearance({ ...readStoredTerminalAppearance(), preset: "custom" }),
  );
  const [fontSizeInput, setFontSizeInput] = useState(() => String(terminalAppearance.fontSize));
  const [lineHeightInput, setLineHeightInput] = useState(() => terminalAppearance.lineHeight.toFixed(2));

  const activeProject = useMemo(
    () => state.projects.find((project) => project.id === state.activeProjectId) ?? null,
    [state.activeProjectId, state.projects],
  );
  const windowProject = useMemo(
    () => state.projects.find((project) => project.id === windowProjectId) ?? null,
    [state.projects, windowProjectId],
  );
  const currentProject = windowProject || activeProject;
  const appHeaderTitle = currentProject?.name || emptyProjectTitle;
  const appHeaderSubtitle = currentProject?.path || "打开项目目录";
  const appHeaderTooltip = currentProject?.path || emptyProjectTitle;
  const terminalChromeVars = useMemo(() => {
    const chrome = getTerminalChrome(terminalAppearance);
    return {
      "--terminal-bg": chrome.background,
      "--terminal-fg": chrome.foreground,
      "--terminal-panel": chrome.panel,
      "--terminal-border": chrome.border,
      "--terminal-muted": chrome.muted,
      "--terminal-accent": chrome.accent,
      "--app-sidebar": chrome.sidebar,
      "--app-sidebar-strong": chrome.sidebarStrong,
      "--app-border": chrome.sidebarBorder,
      "--app-text": chrome.sidebarText,
      "--app-muted": chrome.sidebarMuted,
      "--app-soft": chrome.sidebarSoft,
    } as CSSProperties;
  }, [terminalAppearance]);

  async function loadState() {
    const [loaded, initialProjectId] = await Promise.all([
      invoke<WorkbenchState>("load_state"),
      windowProjectId
        ? Promise.resolve(windowProjectId)
        : invoke<string | null>("initial_project_id").catch(() => null),
    ]);

    if (initialProjectId && initialProjectId !== windowProjectId) {
      setWindowProjectId(initialProjectId);
    }

    const nextState = applyWindowProject(loaded, initialProjectId || loaded.projects[0]?.id || loaded.activeProjectId);
    setState(nextState);
    if (loaded.terminalAppearance) {
      setTerminalAppearance(normalizeTerminalAppearance(loaded.terminalAppearance));
    }
    if (loaded.customTerminalAppearance) {
      setCustomTerminalAppearance(
        normalizeTerminalAppearance({ ...loaded.customTerminalAppearance, preset: "custom" }),
      );
    } else if (loaded.terminalAppearance?.preset === "custom") {
      setCustomTerminalAppearance(normalizeTerminalAppearance(loaded.terminalAppearance));
    }
    return nextState;
  }

  function applyWindowProject(
    loaded: WorkbenchState,
    projectId = windowProjectId,
  ): WorkbenchState {
    if (!projectId || !loaded.projects.some((project) => project.id === projectId)) {
      return loaded;
    }

    return {
      ...loaded,
      activeProjectId: projectId,
    };
  }

  useEffect(() => {
    loadState().catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    cacheTerminalAppearance(terminalAppearance);
  }, [terminalAppearance]);

  useEffect(() => {
    setFontSizeInput(String(terminalAppearance.fontSize));
  }, [terminalAppearance.fontSize]);

  useEffect(() => {
    setLineHeightInput(terminalAppearance.lineHeight.toFixed(2));
  }, [terminalAppearance.lineHeight]);

  useEffect(() => {
    const title = currentProject?.name || emptyProjectTitle;
    document.title = title;
    getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [currentProject?.name]);

  async function chooseProject() {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;

    const updated = await invoke<WorkbenchState>("upsert_project", { path: selected });
    if (windowProjectId && updated.activeProjectId) {
      setWindowProjectId(updated.activeProjectId);
    }
    setState(windowProjectId ? applyWindowProject(updated, updated.activeProjectId) : updated);
  }

  async function setActive(projectId: string) {
    setError(null);
    if (windowProjectId) {
      setWindowProjectId(projectId);
      setState((current) => ({
        ...current,
        activeProjectId: projectId,
      }));
      return;
    }

    const updated = await invoke<WorkbenchState>("set_active_project", { projectId });
    setState(updated);
  }

  function moveProject(
    projects: WorkbenchState["projects"],
    projectId: string,
    targetProjectId: string,
    placement: ProjectDropPlacement,
  ) {
    const fromIndex = projects.findIndex((project) => project.id === projectId);
    const toIndex = projects.findIndex((project) => project.id === targetProjectId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return projects;

    const orderedProjects = [...projects];
    const [project] = orderedProjects.splice(fromIndex, 1);
    const nextTargetIndex = orderedProjects.findIndex((item) => item.id === targetProjectId);
    const insertIndex = placement === "after" ? nextTargetIndex + 1 : nextTargetIndex;
    orderedProjects.splice(insertIndex, 0, project);
    return orderedProjects;
  }

  async function persistProjectOrder(projects: WorkbenchState["projects"]) {
    const updated = await invoke<WorkbenchState>("reorder_projects", {
      projectIds: projects.map((project) => project.id),
    });
    setState(applyWindowProject(updated));
  }

  function getProjectDropPlacement(event: React.DragEvent<HTMLElement>): ProjectDropPlacement {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  }

  async function finishProjectDrag(targetProjectId: string, placement: ProjectDropPlacement) {
    if (!draggedProjectId) return;

    setProjectDropTarget(null);
    if (draggedProjectId === targetProjectId) return;

    const orderedProjects = moveProject(state.projects, draggedProjectId, targetProjectId, placement);
    if (orderedProjects === state.projects) return;

    setState((current) => ({
      ...current,
      projects: orderedProjects,
    }));
    try {
      await persistProjectOrder(orderedProjects);
    } catch (err) {
      setError(String(err));
      void loadState().catch((loadError) => setError(String(loadError)));
    }
  }

  async function removeProject(projectId: string) {
    setError(null);
    const updated = await invoke<WorkbenchState>("remove_project", { projectId });
    if (windowProjectId === projectId) {
      setWindowProjectId(updated.activeProjectId || null);
      setState(applyWindowProject(updated, updated.activeProjectId));
      return;
    }
    setState(applyWindowProject(updated));
  }

  async function openProjectWindow(projectId: string) {
    setError(null);
    if (openingProjectWindowId) return;

    setOpeningProjectWindowId(projectId);
    try {
      await invoke("open_project_window", { projectId });
    } catch (err) {
      setError(String(err));
    } finally {
      setOpeningProjectWindowId(null);
    }
  }

  function applyThemePreset(preset: BuiltInTerminalThemePreset) {
    updateTerminalAppearance((current) => getTerminalPresetAppearance(preset, current.fontSize, current.lineHeight));
  }

  function applyCustomTheme() {
    updateTerminalAppearance((current) =>
      normalizeTerminalAppearance({
        ...customTerminalAppearance,
        preset: "custom",
        fontSize: current.fontSize,
        lineHeight: current.lineHeight,
      }),
    );
  }

  function changeFontSize(delta: number) {
    updateTerminalAppearance((current) => ({
      ...current,
      fontSize: clampTerminalFontSize(current.fontSize + delta),
    }));
  }

  function commitFontSizeInput(value = fontSizeInput) {
    const parsed = Number(value);
    const nextFontSize = Number.isFinite(parsed)
      ? clampTerminalFontSize(parsed)
      : terminalAppearance.fontSize;

    updateTerminalAppearance((current) => ({
      ...current,
      fontSize: nextFontSize,
    }));
    setFontSizeInput(String(nextFontSize));
  }

  function changeLineHeight(delta: number) {
    updateTerminalAppearance((current) => ({
      ...current,
      lineHeight: clampTerminalLineHeight(current.lineHeight + delta),
    }));
  }

  function commitLineHeightInput(value = lineHeightInput) {
    const parsed = Number(value);
    const nextLineHeight = Number.isFinite(parsed)
      ? clampTerminalLineHeight(parsed)
      : terminalAppearance.lineHeight;

    updateTerminalAppearance((current) => ({
      ...current,
      lineHeight: nextLineHeight,
    }));
    setLineHeightInput(nextLineHeight.toFixed(2));
  }

  function updateTerminalColor(key: TerminalColorKey, value: string) {
    updateTerminalAppearance((current) =>
      normalizeTerminalAppearance({
        ...current,
        preset: "custom",
        [key]: value,
      }),
    );
  }

  function updateTerminalAppearance(
    updater: (current: TerminalAppearanceSettings) => TerminalAppearanceSettings,
  ) {
    setTerminalAppearance((current) => {
      const nextAppearance = normalizeTerminalAppearance(updater(current));
      if (nextAppearance.preset === "custom") {
        setCustomTerminalAppearance(nextAppearance);
      }
      cacheTerminalAppearance(nextAppearance);
      void invoke<WorkbenchState>("set_terminal_appearance", { appearance: nextAppearance }).catch((err) =>
        setError(String(err)),
      );
      return nextAppearance;
    });
  }

  return (
    <main className="shell" style={terminalChromeVars}>
      <aside className="sidebar">
        <div className="project-root">
          <div className="project-root-title" title={appHeaderTooltip}>
            <span className="brand-mark">
              <SquareTerminal size={18} />
            </span>
            <span className="brand-copy">
              <strong>{appHeaderTitle}</strong>
              <small>{appHeaderSubtitle}</small>
            </span>
          </div>
          <button className="sidebar-icon" title="打开项目" onClick={chooseProject}>
            <Plus size={16} />
          </button>
        </div>

        <nav className="project-list" aria-label="项目列表">
          {state.projects.length === 0 ? (
            <button className="empty-project-button" onClick={chooseProject}>
              打开一个项目目录
            </button>
          ) : (
            state.projects.map((project) => (
              <div
                key={project.id}
                className={`project-item ${project.id === currentProject?.id ? "active" : ""} ${
                  project.id === draggedProjectId ? "dragging" : ""
                } ${
                  projectDropTarget?.id === project.id ? `drag-over ${projectDropTarget.placement}` : ""
                }`}
                title={project.path}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (draggedProjectId && draggedProjectId !== project.id) {
                    setProjectDropTarget({ id: project.id, placement: getProjectDropPlacement(event) });
                  }
                }}
                onDragOver={(event) => {
                  if (!draggedProjectId || draggedProjectId === project.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setProjectDropTarget({ id: project.id, placement: getProjectDropPlacement(event) });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void finishProjectDrag(project.id, getProjectDropPlacement(event));
                }}
              >
                <button
                  className="project-drag-handle"
                  draggable
                  title="拖动调整项目顺序"
                  onDragStart={(event) => {
                    setDraggedProjectId(project.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", project.id);
                  }}
                  onDragEnd={() => {
                    setDraggedProjectId(null);
                    setProjectDropTarget(null);
                  }}
                >
                  <GripVertical size={14} />
                </button>
                <button
                  className="project-select"
                  title={project.path}
                  onClick={() => setActive(project.id)}
                >
                  <FolderOpen className="project-item-icon" size={15} />
                  <span className="project-copy">
                    <span className="project-title">{project.name}</span>
                    <span className="project-path">{project.path}</span>
                  </span>
                </button>
                <span className="project-time">{formatRelativeTime(project.lastOpenedAt)}前</span>
                <button
                  className="project-window-button"
                  disabled={openingProjectWindowId === project.id}
                  title="新窗口打开这个项目"
                  onClick={() => openProjectWindow(project.id)}
                >
                  <ExternalLink size={13} />
                </button>
              </div>
            ))
          )}
        </nav>

        <div className="sidebar-footer">
          <span className="project-count">{state.projects.length} 个项目</span>
          <button
            className="footer-button"
            title="刷新"
            onClick={() => loadState()}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-bar">
          <div className="project-heading">
            <div className="terminal-mark">
              <PanelsTopLeft size={18} />
            </div>
            <div>
              <span className="workspace-kicker">当前工作区</span>
              <h2>{currentProject?.name || emptyProjectTitle}</h2>
              <p>{currentProject?.path || "选择项目后，右侧终端会切到对应目录，可按瓦片查看多个任务"}</p>
            </div>
          </div>

          <div className="workspace-actions">
            {currentProject && (
              <button
                className="icon-button"
                disabled={openingProjectWindowId === currentProject.id}
                title="新窗口打开当前项目"
                onClick={() => openProjectWindow(currentProject.id)}
              >
                <ExternalLink size={16} />
              </button>
            )}

            <button
              className={`icon-button ${appearanceOpen ? "active" : ""}`}
              title="终端外观"
              onClick={() => setAppearanceOpen((open) => !open)}
            >
              <Palette size={16} />
            </button>

            {currentProject && (
              <button className="icon-button danger" title="移除项目" onClick={() => removeProject(currentProject.id)}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </header>

        {error && <div className="error-strip">{error}</div>}
        {appearanceOpen && (
          <section className="appearance-bar" aria-label="终端外观">
            <div className="appearance-group theme-group">
              <span className="appearance-label">主题</span>
              <div className="theme-segments">
                {terminalThemePresetOrder.map((preset) => {
                  const palette = terminalThemePresets[preset];
                  return (
                    <button
                      key={preset}
                      className={`theme-choice ${terminalAppearance.preset === preset ? "active" : ""}`}
                      title={`${palette.label}主题`}
                      onClick={() => applyThemePreset(preset)}
                    >
                      <span
                        className="theme-swatch"
                        style={{ background: palette.background, borderColor: palette.cursor }}
                      />
                      {palette.label}
                    </button>
                  );
                })}
                <button
                  className={`theme-choice ${terminalAppearance.preset === "custom" ? "active" : ""}`}
                  title="切换到自定义主题"
                  onClick={applyCustomTheme}
                >
                  <span
                    className="theme-swatch"
                    style={{
                      background: customTerminalAppearance.background || defaultTerminalAppearance.background,
                      borderColor: customTerminalAppearance.cursor || defaultTerminalAppearance.cursor,
                    }}
                  />
                  {customThemeLabel}
                </button>
              </div>
            </div>

            <div className="appearance-group">
              <span className="appearance-label">字号</span>
              <div className="value-stepper">
                <button title="减小字号" onClick={() => changeFontSize(-1)}>
                  <Minus size={13} />
                </button>
                <input
                  aria-label="字号"
                  className="value-input"
                  inputMode="numeric"
                  max="22"
                  min="10"
                  step="1"
                  title="输入 10 到 22 之间的字号"
                  type="number"
                  value={fontSizeInput}
                  onBlur={() => commitFontSizeInput()}
                  onChange={(event) => setFontSizeInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button title="增大字号" onClick={() => changeFontSize(1)}>
                  <Plus size={13} />
                </button>
              </div>
            </div>

            <div className="appearance-group">
              <span className="appearance-label">行距</span>
              <div className="value-stepper">
                <button title="减小行间距" onClick={() => changeLineHeight(-0.04)}>
                  <Minus size={13} />
                </button>
                <input
                  aria-label="行间距"
                  className="value-input"
                  inputMode="decimal"
                  max="1.8"
                  min="1"
                  step="0.01"
                  title="输入 1.00 到 1.80 之间的行间距"
                  type="number"
                  value={lineHeightInput}
                  onBlur={() => commitLineHeightInput()}
                  onChange={(event) => setLineHeightInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button title="增大行间距" onClick={() => changeLineHeight(0.04)}>
                  <Plus size={13} />
                </button>
              </div>
            </div>

            <div className="appearance-group color-group">
              {colorFields.map((field) => (
                <label className="color-field" key={field.key}>
                  <span>{field.label}</span>
                  <input
                    type="color"
                    value={terminalAppearance[field.key]}
                    onChange={(event) => updateTerminalColor(field.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </section>
        )}

        <TerminalPane
          activeProjectId={currentProject?.id || null}
          activeProjectName={currentProject?.name || null}
          activeProjectPath={currentProject?.path || null}
          appearance={terminalAppearance}
          onError={setError}
          onProjectFocus={setActive}
        />
      </section>
    </main>
  );
}
