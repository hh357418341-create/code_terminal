import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Minus, Palette, PanelsTopLeft, Plus, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TerminalPane } from "./TerminalPane";
import {
  clampTerminalFontSize,
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
const productName = "Code Terminal";
const appearanceStorageKey = "opencode-workbench.terminal-appearance";
const colorFields: Array<{ key: TerminalColorKey; label: string }> = [
  { key: "background", label: "背景" },
  { key: "foreground", label: "文字" },
  { key: "cursor", label: "光标" },
];

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
  const [state, setState] = useState<WorkbenchState>(emptyState);
  const [error, setError] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearanceSettings>(
    readStoredTerminalAppearance,
  );

  const activeProject = useMemo(
    () => state.projects.find((project) => project.id === state.activeProjectId) ?? null,
    [state.activeProjectId, state.projects],
  );
  const terminalChromeVars = useMemo(() => {
    const chrome = getTerminalChrome(terminalAppearance);
    return {
      "--terminal-bg": chrome.background,
      "--terminal-fg": chrome.foreground,
      "--terminal-panel": chrome.panel,
      "--terminal-border": chrome.border,
      "--terminal-muted": chrome.muted,
      "--terminal-accent": chrome.accent,
    } as CSSProperties;
  }, [terminalAppearance]);

  async function loadState() {
    const loaded = await invoke<WorkbenchState>("load_state");
    setState(loaded);
    return loaded;
  }

  useEffect(() => {
    loadState().catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(appearanceStorageKey, JSON.stringify(terminalAppearance));
  }, [terminalAppearance]);

  async function chooseProject() {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;

    const updated = await invoke<WorkbenchState>("upsert_project", { path: selected });
    setState(updated);
  }

  async function setActive(projectId: string) {
    setError(null);
    const updated = await invoke<WorkbenchState>("set_active_project", { projectId });
    setState(updated);
  }

  async function removeProject(projectId: string) {
    setError(null);
    const updated = await invoke<WorkbenchState>("remove_project", { projectId });
    setState(updated);
  }

  function applyThemePreset(preset: BuiltInTerminalThemePreset) {
    setTerminalAppearance((current) => getTerminalPresetAppearance(preset, current.fontSize));
  }

  function changeFontSize(delta: number) {
    setTerminalAppearance((current) => ({
      ...current,
      fontSize: clampTerminalFontSize(current.fontSize + delta),
    }));
  }

  function updateTerminalColor(key: TerminalColorKey, value: string) {
    setTerminalAppearance((current) =>
      normalizeTerminalAppearance({
        ...current,
        preset: "custom",
        [key]: value,
      }),
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="project-root">
          <div className="project-root-title" title={productName}>
            <span className="brand-mark">
              <SquareTerminal size={18} />
            </span>
            <span className="brand-copy">
              <strong>{productName}</strong>
              <small>Terminal Workbench</small>
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
              <button
                key={project.id}
                className={`project-item ${project.id === state.activeProjectId ? "active" : ""}`}
                title={project.path}
                onClick={() => setActive(project.id)}
              >
                <FolderOpen className="project-item-icon" size={15} />
                <span className="project-copy">
                  <span className="project-title">{project.name}</span>
                  <span className="project-path">{project.path}</span>
                </span>
                <span className="project-time">{formatRelativeTime(project.lastOpenedAt)}前</span>
              </button>
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

      <section className="workspace" style={terminalChromeVars}>
        <header className="workspace-bar">
          <div className="project-heading">
            <div className="terminal-mark">
              <PanelsTopLeft size={18} />
            </div>
            <div>
              <span className="workspace-kicker">当前工作区</span>
              <h2>{activeProject?.name || productName}</h2>
              <p>{activeProject?.path || "选择项目后，右侧终端会切到对应目录，可按瓦片查看多个任务"}</p>
            </div>
          </div>

          <div className="workspace-actions">
            <button
              className={`icon-button ${appearanceOpen ? "active" : ""}`}
              title="终端外观"
              onClick={() => setAppearanceOpen((open) => !open)}
            >
              <Palette size={16} />
            </button>

            {activeProject && (
              <button className="icon-button danger" title="移除项目" onClick={() => removeProject(activeProject.id)}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </header>

        {error && <div className="error-strip">{error}</div>}
        {appearanceOpen && (
          <section className="appearance-bar" aria-label="终端外观">
            <div className="appearance-group">
              <span className="appearance-label">主题</span>
              <div className="theme-segments">
                {terminalThemePresetOrder.map((preset) => {
                  const palette = terminalThemePresets[preset];
                  return (
                    <button
                      key={preset}
                      className={`theme-choice ${terminalAppearance.preset === preset ? "active" : ""}`}
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
              </div>
            </div>

            <div className="appearance-group">
              <span className="appearance-label">字号</span>
              <div className="font-stepper">
                <button title="减小字号" onClick={() => changeFontSize(-1)}>
                  <Minus size={13} />
                </button>
                <output>{terminalAppearance.fontSize}</output>
                <button title="增大字号" onClick={() => changeFontSize(1)}>
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
          activeProjectId={activeProject?.id || null}
          activeProjectPath={activeProject?.path || null}
          appearance={terminalAppearance}
          onError={setError}
        />
      </section>
    </main>
  );
}
