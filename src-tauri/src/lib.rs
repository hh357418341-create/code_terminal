use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkbenchState {
    projects: Vec<Project>,
    active_project_id: Option<String>,
    #[serde(default)]
    terminal_appearance: Option<TerminalAppearanceSettings>,
    #[serde(default)]
    custom_terminal_appearance: Option<TerminalAppearanceSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    status: ProjectStatus,
    last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAppearanceSettings {
    preset: String,
    font_size: u8,
    line_height: f64,
    background: String,
    foreground: String,
    cursor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProjectStatus {
    Idle,
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStarted {
    session_id: String,
    shell: String,
    cwd: String,
    windows_build_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    code: Option<i32>,
}

const MAX_PASTED_IMAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Default)]
struct TerminalRegistry(Mutex<HashMap<String, TerminalSession>>);

struct TerminalSession {
    project_id: Option<String>,
    child: Box<dyn PtyChild + Send>,
    control_tx: mpsc::Sender<TerminalControl>,
}

enum TerminalControl {
    Write(String),
    Resize { cols: u16, rows: u16 },
    Stop,
}

struct StateStore(Mutex<WorkbenchState>);

struct InitialProjectId(Option<String>);

impl Default for WorkbenchState {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            active_project_id: None,
            terminal_appearance: None,
            custom_terminal_appearance: None,
        }
    }
}

#[tauri::command]
fn load_state(store: State<'_, StateStore>) -> Result<WorkbenchState, String> {
    Ok(store.0.lock().map_err(lock_error)?.clone())
}

#[tauri::command]
fn initial_project_id(initial_project_id: State<'_, InitialProjectId>) -> Option<String> {
    initial_project_id.0.clone()
}

#[tauri::command]
fn set_terminal_appearance(
    app: AppHandle,
    store: State<'_, StateStore>,
    appearance: TerminalAppearanceSettings,
) -> Result<WorkbenchState, String> {
    {
        let mut state = store.0.lock().map_err(lock_error)?;
        let appearance = normalize_terminal_appearance(appearance);
        if appearance.preset == "custom" {
            state.custom_terminal_appearance = Some(appearance.clone());
        }
        state.terminal_appearance = Some(appearance);
        save_state_to_disk(&app, &state)?;
    }

    load_state(store)
}

#[tauri::command]
fn upsert_project(
    app: AppHandle,
    store: State<'_, StateStore>,
    path: String,
) -> Result<WorkbenchState, String> {
    let path = normalize_project_path(&path)?;
    let now = now_unix();
    let name = project_name(&path);

    {
        let mut state = store.0.lock().map_err(lock_error)?;
        if let Some(project) = state
            .projects
            .iter_mut()
            .find(|project| project.path == path)
        {
            project.last_opened_at = now;
            state.active_project_id = Some(project.id.clone());
        } else {
            let id = Uuid::new_v4().to_string();
            state.projects.insert(
                0,
                Project {
                    id: id.clone(),
                    name,
                    path,
                    status: ProjectStatus::Idle,
                    last_opened_at: now,
                },
            );
            state.active_project_id = Some(id);
        }
        save_state_to_disk(&app, &state)?;
    }

    load_state(store)
}

#[tauri::command]
fn set_active_project(
    app: AppHandle,
    store: State<'_, StateStore>,
    project_id: String,
) -> Result<WorkbenchState, String> {
    {
        let mut state = store.0.lock().map_err(lock_error)?;
        if !state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err("项目不存在".into());
        }
        state.active_project_id = Some(project_id);
        save_state_to_disk(&app, &state)?;
    }
    load_state(store)
}

#[tauri::command]
fn remove_project(
    app: AppHandle,
    store: State<'_, StateStore>,
    terminals: State<'_, TerminalRegistry>,
    project_id: String,
) -> Result<WorkbenchState, String> {
    stop_terminals_for_project(&terminals, &project_id)?;

    {
        let mut state = store.0.lock().map_err(lock_error)?;
        state.projects.retain(|project| project.id != project_id);
        if state.active_project_id.as_deref() == Some(&project_id) {
            state.active_project_id = state.projects.first().map(|project| project.id.clone());
        }
        save_state_to_disk(&app, &state)?;
    }

    load_state(store)
}

#[tauri::command]
fn open_project_window(
    app: AppHandle,
    store: State<'_, StateStore>,
    project_id: String,
) -> Result<(), String> {
    let project = {
        let mut state = store.0.lock().map_err(lock_error)?;
        let index = state
            .projects
            .iter()
            .position(|project| project.id == project_id)
            .ok_or_else(|| "项目不存在".to_string())?;

        state.projects[index].last_opened_at = now_unix();
        let project = state.projects[index].clone();
        save_state_to_disk(&app, &state)?;
        project
    };

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    Command::new(executable)
        .arg("--project-id")
        .arg(project.id)
        .spawn()
        .map_err(|error| format!("打开项目窗口失败：{error}"))?;

    Ok(())
}

#[tauri::command]
fn terminal_start(
    app: AppHandle,
    store: State<'_, StateStore>,
    terminals: State<'_, TerminalRegistry>,
    session_id: String,
    project_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalStarted, String> {
    let cwd = resolve_terminal_cwd(&store, project_id.as_deref())?;
    if terminals
        .0
        .lock()
        .map_err(lock_error)?
        .contains_key(&session_id)
    {
        return Err("终端会话已存在".into());
    }

    let (program, args, shell_label) = default_terminal_shell();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(program);
    for arg in args {
        command.arg(arg);
    }
    configure_terminal_environment(&mut command);
    command.cwd(cwd.clone());

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动本地终端失败：{error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let master = pair.master;
    let (control_tx, control_rx) = mpsc::channel::<TerminalControl>();
    let output_session_id = session_id.clone();
    let exit_session_id = session_id.clone();
    let app_for_thread = app.clone();

    thread::spawn(move || {
        let mut writer = writer;
        let master = master;

        while let Ok(message) = control_rx.recv() {
            match message {
                TerminalControl::Write(data) => {
                    if writer
                        .write_all(data.as_bytes())
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                TerminalControl::Resize { cols, rows } => {
                    let _ = master.resize(PtySize {
                        rows: rows.max(8),
                        cols: cols.max(20),
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                TerminalControl::Stop => break,
            }
        }
    });

    thread::spawn(move || {
        let mut buffer = [0_u8; 1024];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    emit_terminal_output(
                        &app_for_thread,
                        &output_session_id,
                        &mut pending_utf8,
                        &buffer[..size],
                    );
                }
                Err(_) => break,
            }
        }
        flush_terminal_output(&app_for_thread, &output_session_id, &mut pending_utf8);
        let _ = app_for_thread.emit(
            "terminal-exit",
            TerminalExit {
                session_id: exit_session_id,
                code: None,
            },
        );
    });

    {
        let mut sessions = terminals.0.lock().map_err(lock_error)?;
        sessions.insert(
            session_id.clone(),
            TerminalSession {
                project_id,
                child,
                control_tx,
            },
        );
    }

    Ok(TerminalStarted {
        session_id,
        shell: shell_label,
        cwd: path_to_string(&cwd),
        windows_build_number: windows_build_number(),
    })
}

#[tauri::command]
fn terminal_write(
    terminals: State<'_, TerminalRegistry>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let control_tx = {
        let sessions = terminals.0.lock().map_err(lock_error)?;
        sessions
            .get(&session_id)
            .map(|session| session.control_tx.clone())
            .ok_or_else(|| "终端会话不存在".to_string())?
    };

    control_tx
        .send(TerminalControl::Write(data))
        .map_err(|_| "终端会话已关闭".to_string())
}

#[tauri::command]
fn terminal_resize(
    terminals: State<'_, TerminalRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let control_tx = {
        let sessions = terminals.0.lock().map_err(lock_error)?;
        sessions
            .get(&session_id)
            .map(|session| session.control_tx.clone())
            .ok_or_else(|| "终端会话不存在".to_string())?
    };

    control_tx
        .send(TerminalControl::Resize { cols, rows })
        .map_err(|_| "终端会话已关闭".to_string())
}

#[tauri::command]
fn terminal_stop(terminals: State<'_, TerminalRegistry>, session_id: String) -> Result<(), String> {
    stop_terminal_session(&terminals, &session_id)
}

#[tauri::command]
fn save_pasted_image(mime_type: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("剪贴板图片为空".into());
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("剪贴板图片过大，无法临时保存".into());
    }

    let extension = pasted_image_extension(&mime_type)
        .ok_or_else(|| format!("不支持的图片类型：{mime_type}"))?;
    let dir = std::env::temp_dir()
        .join("code-terminal")
        .join("pasted-images");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let path = dir.join(format!("paste-{}.{}", Uuid::new_v4(), extension));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;

    Ok(path_to_string(&path))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = load_state_from_disk(&app.handle()).unwrap_or_default();
            let initial_project_id = initial_project_id_from_args();
            if let Some(title) = initial_window_title(&state, initial_project_id.as_deref()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&title);
                }
            }

            app.manage(StateStore(Mutex::new(state)));
            app.manage(InitialProjectId(initial_project_id));
            app.manage(TerminalRegistry::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            initial_project_id,
            set_terminal_appearance,
            upsert_project,
            set_active_project,
            remove_project,
            open_project_window,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            save_pasted_image
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let terminals = app_handle.state::<TerminalRegistry>();
                let terminal_sessions = terminals.0.lock().map(|mut sessions| {
                    sessions
                        .drain()
                        .map(|(_, session)| session)
                        .collect::<Vec<_>>()
                });

                if let Ok(terminal_sessions) = terminal_sessions {
                    for session in terminal_sessions {
                        stop_detached_terminal_session(session);
                    }
                }
            }
        });
}

fn load_state_from_disk(app: &AppHandle) -> Result<WorkbenchState, String> {
    let path = state_file_path(app)?;
    if !path.exists() {
        return Ok(WorkbenchState::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut state: WorkbenchState =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;
    for project in &mut state.projects {
        project.status = ProjectStatus::Stopped;
        project.path = normalize_existing_path(&project.path);
    }
    Ok(state)
}

fn save_state_to_disk(app: &AppHandle, state: &WorkbenchState) -> Result<(), String> {
    let path = state_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join("workbench-state.json"))
}

fn emit_terminal_output(
    app: &AppHandle,
    session_id: &str,
    pending_utf8: &mut Vec<u8>,
    bytes: &[u8],
) {
    pending_utf8.extend_from_slice(bytes);

    loop {
        if pending_utf8.is_empty() {
            return;
        }

        match std::str::from_utf8(pending_utf8) {
            Ok(text) => {
                let data = text.to_string();
                pending_utf8.clear();
                emit_terminal_text(app, session_id, data);
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    let data = String::from_utf8_lossy(&pending_utf8[..valid_up_to]).to_string();
                    pending_utf8.drain(..valid_up_to);
                    emit_terminal_text(app, session_id, data);
                    continue;
                }

                if let Some(error_len) = error.error_len() {
                    let data = String::from_utf8_lossy(&pending_utf8[..error_len]).to_string();
                    pending_utf8.drain(..error_len);
                    emit_terminal_text(app, session_id, data);
                    continue;
                }

                return;
            }
        }
    }
}

fn flush_terminal_output(app: &AppHandle, session_id: &str, pending_utf8: &mut Vec<u8>) {
    if pending_utf8.is_empty() {
        return;
    }

    let data = String::from_utf8_lossy(pending_utf8).to_string();
    pending_utf8.clear();
    emit_terminal_text(app, session_id, data);
}

fn emit_terminal_text(app: &AppHandle, session_id: &str, data: String) {
    if data.is_empty() {
        return;
    }

    let _ = app.emit(
        "terminal-output",
        TerminalOutput {
            session_id: session_id.to_string(),
            data,
        },
    );
}

fn canonicalize_clean(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map(clean_windows_verbatim_path)
        .map_err(|error| error.to_string())
}

fn normalize_existing_path(path: &str) -> String {
    let path = PathBuf::from(clean_windows_verbatim_path_str(path));
    if path.exists() {
        canonicalize_clean(&path)
            .map(|path| path_to_string(&path))
            .unwrap_or_else(|_| path_to_string(&path))
    } else {
        path_to_string(&path)
    }
}

fn path_to_string(path: &Path) -> String {
    clean_windows_verbatim_path_str(&path.to_string_lossy())
}

fn clean_windows_verbatim_path(path: PathBuf) -> PathBuf {
    PathBuf::from(clean_windows_verbatim_path_str(&path.to_string_lossy()))
}

fn clean_windows_verbatim_path_str(path: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }

    path.to_string()
}

fn normalize_project_path(path: &str) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("目录不存在".into());
    }
    if !path.is_dir() {
        return Err("请选择目录".into());
    }
    canonicalize_clean(&path).map(|path| path_to_string(&path))
}

fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Project")
        .to_string()
}

fn stop_terminal_session(
    registry: &State<'_, TerminalRegistry>,
    session_id: &str,
) -> Result<(), String> {
    let session = {
        let mut sessions = registry.0.lock().map_err(lock_error)?;
        sessions.remove(session_id)
    };

    if let Some(session) = session {
        stop_detached_terminal_session(session);
    }
    Ok(())
}

fn stop_terminals_for_project(
    registry: &State<'_, TerminalRegistry>,
    project_id: &str,
) -> Result<(), String> {
    let terminal_sessions = {
        let mut sessions = registry.0.lock().map_err(lock_error)?;
        let matching_session_ids = sessions
            .iter()
            .filter_map(|(session_id, session)| {
                if session.project_id.as_deref() == Some(project_id) {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        matching_session_ids
            .into_iter()
            .filter_map(|session_id| sessions.remove(&session_id))
            .collect::<Vec<_>>()
    };

    for session in terminal_sessions {
        stop_detached_terminal_session(session);
    }

    Ok(())
}

fn stop_detached_terminal_session(mut session: TerminalSession) {
    let _ = session.control_tx.send(TerminalControl::Stop);
    let _ = session.child.kill();
}

fn pasted_image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

fn initial_project_id_from_args() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--project-id" {
            return args.next().filter(|value| !value.trim().is_empty());
        }

        if let Some(value) = arg.strip_prefix("--project-id=") {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

fn initial_window_title(
    state: &WorkbenchState,
    initial_project_id: Option<&str>,
) -> Option<String> {
    let project_id = initial_project_id.or(state.active_project_id.as_deref())?;
    state
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .map(|project| project.name.clone())
}

fn normalize_terminal_appearance(
    appearance: TerminalAppearanceSettings,
) -> TerminalAppearanceSettings {
    TerminalAppearanceSettings {
        preset: if is_terminal_theme_preset(&appearance.preset) {
            appearance.preset
        } else {
            "custom".into()
        },
        font_size: appearance.font_size.clamp(10, 22),
        line_height: clamp_terminal_line_height(appearance.line_height),
        background: sanitize_hex_color(&appearance.background, "#070b10"),
        foreground: sanitize_hex_color(&appearance.foreground, "#d7dde7"),
        cursor: sanitize_hex_color(&appearance.cursor, "#8ab4ff"),
    }
}

fn is_terminal_theme_preset(value: &str) -> bool {
    matches!(
        value,
        "workbench"
            | "daylight"
            | "midnight"
            | "ocean"
            | "jade"
            | "violet"
            | "rose"
            | "amber"
            | "classic"
            | "custom"
    )
}

fn clamp_terminal_line_height(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.28;
    }

    (value.clamp(1.0, 1.8) * 100.0).round() / 100.0
}

fn sanitize_hex_color(value: &str, fallback: &str) -> String {
    if value.len() == 7
        && value.starts_with('#')
        && value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit())
    {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

fn resolve_terminal_cwd(
    store: &State<'_, StateStore>,
    project_id: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(project_id) = project_id {
        let state = store.0.lock().map_err(lock_error)?;
        let project = state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| "项目不存在".to_string())?;
        let path = PathBuf::from(&project.path);
        if !path.exists() || !path.is_dir() {
            return Err("项目路径不存在".into());
        }
        return canonicalize_clean(&path);
    }

    std::env::current_dir()
        .map_err(|error| error.to_string())
        .map(clean_windows_verbatim_path)
}

#[cfg(windows)]
fn default_terminal_shell() -> (String, Vec<String>, String) {
    (
        "powershell.exe".into(),
        vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NoExit".into(),
            "-Command".into(),
            powershell_startup_script().into(),
        ],
        "PowerShell".into(),
    )
}

#[cfg(not(windows))]
fn default_terminal_shell() -> (String, Vec<String>, String) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    (shell.clone(), Vec::new(), shell)
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    #[cfg(windows)]
    command.env("POWERSHELL_UPDATECHECK", "Off");
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    Some(windows_version::OsVersion::current().build)
}

#[cfg(not(windows))]
fn windows_build_number() -> Option<u32> {
    None
}

#[cfg(windows)]
fn powershell_startup_script() -> &'static str {
    "$ProgressPreference='SilentlyContinue';try{$c=Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue;if($c){if($c.Parameters.ContainsKey('PredictionSource')){Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue};if($c.Parameters.ContainsKey('BellStyle')){Set-PSReadLineOption -BellStyle None -ErrorAction SilentlyContinue}}}catch{}"
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    error.to_string()
}
