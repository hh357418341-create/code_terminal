export type ProjectStatus = "idle" | "running" | "stopped" | "error";

export interface Project {
  id: string;
  name: string;
  path: string;
  status: ProjectStatus;
  lastOpenedAt: number;
}

export interface WorkbenchState {
  projects: Project[];
  activeProjectId?: string | null;
}

export type BuiltInTerminalThemePreset = "workbench" | "daylight" | "midnight" | "classic";
export type TerminalThemePreset = BuiltInTerminalThemePreset | "custom";
export type TerminalColorKey = "background" | "foreground" | "cursor";

export interface TerminalAppearanceSettings {
  preset: TerminalThemePreset;
  fontSize: number;
  background: string;
  foreground: string;
  cursor: string;
}

export interface CliStatus {
  available: boolean;
  version?: string | null;
  message?: string | null;
}

export interface TerminalStarted {
  sessionId: string;
  shell: string;
  cwd: string;
  windowsBuildNumber?: number | null;
}

export interface TerminalOutput {
  sessionId: string;
  data: string;
}

export interface TerminalExit {
  sessionId: string;
  code?: number | null;
}

export interface TerminalCommandRequest {
  id: number;
  command: string;
}
