use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

const MAX_PASTED_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_ADDR: &str = "127.0.0.1:8787";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStarted {
    session_id: String,
    shell: String,
    cwd: String,
    windows_build_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerEvent {
    TerminalOutput(TerminalOutput),
    TerminalExit(TerminalExit),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerEventMessage<T> {
    #[serde(rename = "type")]
    event_type: &'static str,
    payload: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertProjectRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDirectoryRequest {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDirectoryRequest {
    parent_path: String,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent_path: Option<String>,
    entries: Vec<DirectoryEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIdRequest {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderProjectsRequest {
    project_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetTerminalAppearanceRequest {
    appearance: TerminalAppearanceSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStartRequest {
    session_id: String,
    project_id: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteRequest {
    session_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeRequest {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStopRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePastedImageRequest {
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Clone)]
struct AppState {
    config: ServerConfig,
    state_store: Arc<Mutex<WorkbenchState>>,
    terminals: Arc<Mutex<HashMap<String, TerminalSession>>>,
    events: broadcast::Sender<ServerEvent>,
}

#[derive(Clone)]
struct ServerConfig {
    addr: SocketAddr,
    token: Option<String>,
    state_file: PathBuf,
    static_dir: PathBuf,
}

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

pub async fn run() -> Result<(), String> {
    let config = read_server_config()?;
    let state = load_state_from_disk(&config.state_file)?;
    let (events, _) = broadcast::channel(512);
    let app_state = AppState {
        config: config.clone(),
        state_store: Arc::new(Mutex::new(state)),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        events,
    };

    let static_service = ServeDir::new(&config.static_dir)
        .not_found_service(ServeFile::new(config.static_dir.join("index.html")));
    let app = Router::new()
        .route("/api/load_state", get(load_state))
        .route("/api/initial_project_id", get(initial_project_id))
        .route(
            "/api/set_terminal_appearance",
            post(set_terminal_appearance),
        )
        .route("/api/list_directory", post(list_directory))
        .route("/api/create_directory", post(create_directory))
        .route("/api/upsert_project", post(upsert_project))
        .route("/api/set_active_project", post(set_active_project))
        .route("/api/reorder_projects", post(reorder_projects))
        .route("/api/remove_project", post(remove_project))
        .route("/api/open_project_window", post(open_project_window))
        .route("/api/open_project_folder", post(open_project_folder))
        .route("/api/terminal_start", post(terminal_start))
        .route("/api/terminal_write", post(terminal_write))
        .route("/api/terminal_resize", post(terminal_resize))
        .route("/api/terminal_stop", post(terminal_stop))
        .route("/api/save_pasted_image", post(save_pasted_image))
        .route("/api/events", get(events_ws))
        .fallback_service(static_service)
        .with_state(app_state.clone());

    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .map_err(|error| error.to_string())?;
    println!("code-terminal server listening on http://{}", config.addr);
    if config.token.is_some() {
        println!("auth token enabled; open with ?token=<CODE_TERMINAL_TOKEN>");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(app_state))
        .await
        .map_err(|error| error.to_string())
}

fn read_server_config() -> Result<ServerConfig, String> {
    let addr_value = env::var("CODE_TERMINAL_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.into());
    let addr = parse_listen_addr(&addr_value)?;
    let token = env::var("CODE_TERMINAL_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if !addr.ip().is_loopback() && token.is_none() {
        return Err(
            "CODE_TERMINAL_TOKEN is required when CODE_TERMINAL_ADDR is not localhost".into(),
        );
    }

    let state_file = env::var("CODE_TERMINAL_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_state_file());
    let static_dir = env::var("CODE_TERMINAL_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_static_dir());
    if !static_dir.join("index.html").exists() {
        return Err(format!(
            "frontend dist not found at {}; run npm run build:frontend first",
            static_dir.display()
        ));
    }

    Ok(ServerConfig {
        addr,
        token,
        state_file,
        static_dir,
    })
}

fn parse_listen_addr(value: &str) -> Result<SocketAddr, String> {
    let trimmed = value.trim();
    let normalized = if let Some(port) = trimmed.strip_prefix("localhost:") {
        format!("127.0.0.1:{port}")
    } else {
        trimmed.to_string()
    };

    normalized
        .parse()
        .map_err(|error| format!("invalid CODE_TERMINAL_ADDR \"{value}\": {error}"))
}

fn default_state_file() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".code-terminal")
        .join("workbench-state.json")
}

fn default_static_dir() -> PathBuf {
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dist")
}

async fn shutdown_signal(state: AppState) {
    let _ = tokio::signal::ctrl_c().await;
    if let Ok(mut sessions) = state.terminals.lock() {
        for (_, session) in sessions.drain() {
            stop_detached_terminal_session(session);
        }
    }
}

fn authorize(
    config: &ServerConfig,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<(), ApiError> {
    let Some(expected_token) = config.token.as_deref() else {
        return Ok(());
    };

    if query_token == Some(expected_token) {
        return Ok(());
    }

    let auth_token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if auth_token == Some(expected_token) {
        return Ok(());
    }

    let header_token = headers
        .get("x-code-terminal-token")
        .and_then(|value| value.to_str().ok());
    if header_token == Some(expected_token) {
        return Ok(());
    }

    Err(ApiError::unauthorized())
}

async fn load_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Result<Json<WorkbenchState>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    Ok(Json(state.state_store.lock().map_err(lock_error)?.clone()))
}

async fn initial_project_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Result<Json<Option<String>>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    Ok(Json(None))
}

async fn set_terminal_appearance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<SetTerminalAppearanceRequest>,
) -> Result<Json<WorkbenchState>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    let next_state = {
        let mut current = state.state_store.lock().map_err(lock_error)?;
        let appearance = normalize_terminal_appearance(request.appearance);
        if appearance.preset == "custom" {
            current.custom_terminal_appearance = Some(appearance.clone());
        }
        current.terminal_appearance = Some(appearance);
        save_state_to_disk(&state.config.state_file, &current)?;
        current.clone()
    };
    Ok(Json(next_state))
}

async fn list_directory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<ListDirectoryRequest>,
) -> Result<Json<DirectoryListing>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    Ok(Json(directory_listing(request.path.as_deref())?))
}

async fn create_directory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<CreateDirectoryRequest>,
) -> Result<Json<DirectoryListing>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    let parent = normalize_directory_path(&request.parent_path)?;
    let name = normalize_new_directory_name(&request.name)?;
    let target = parent.join(name);
    if target.exists() {
        return Err(ApiError::bad_request("文件夹已存在"));
    }

    fs::create_dir(&target).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(directory_listing(Some(&path_to_string(&parent)))?))
}

async fn upsert_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<UpsertProjectRequest>,
) -> Result<Json<WorkbenchState>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    let path = normalize_project_path(&request.path)?;
    let now = now_unix();
    let name = project_name(&path);
    let next_state = {
        let mut current = state.state_store.lock().map_err(lock_error)?;
        if let Some(project) = current
            .projects
            .iter_mut()
            .find(|project| project.path == path)
        {
            project.last_opened_at = now;
            current.active_project_id = Some(project.id.clone());
        } else {
            let id = Uuid::new_v4().to_string();
            current.projects.insert(
                0,
                Project {
                    id: id.clone(),
                    name,
                    path,
                    status: ProjectStatus::Idle,
                    last_opened_at: now,
                },
            );
            current.active_project_id = Some(id);
        }
        save_state_to_disk(&state.config.state_file, &current)?;
        current.clone()
    };
    Ok(Json(next_state))
}

async fn set_active_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<ProjectIdRequest>,
) -> Result<Json<WorkbenchState>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    let next_state = {
        let mut current = state.state_store.lock().map_err(lock_error)?;
        if !current
            .projects
            .iter()
            .any(|project| project.id == request.project_id)
        {
            return Err(ApiError::bad_request("项目不存在"));
        }
        current.active_project_id = Some(request.project_id);
        save_state_to_disk(&state.config.state_file, &current)?;
        current.clone()
    };
    Ok(Json(next_state))
}

async fn reorder_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<ReorderProjectsRequest>,
) -> Result<Json<WorkbenchState>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    let next_state = {
        let mut current = state.state_store.lock().map_err(lock_error)?;
        if request.project_ids.len() != current.projects.len() {
            return Err(ApiError::bad_request("项目排序不完整"));
        }

        let mut remaining = current.projects.clone();
        let mut ordered_projects = Vec::with_capacity(remaining.len());
        for project_id in request.project_ids {
            let index = remaining
                .iter()
                .position(|project| project.id == project_id)
                .ok_or_else(|| ApiError::bad_request("项目排序包含未知项目"))?;
            ordered_projects.push(remaining.remove(index));
        }
        if !remaining.is_empty() {
            return Err(ApiError::bad_request("项目排序包含重复项目"));
        }

        current.projects = ordered_projects;
        if !current
            .projects
            .iter()
            .any(|project| Some(&project.id) == current.active_project_id.as_ref())
        {
            current.active_project_id = current.projects.first().map(|project| project.id.clone());
        }
        save_state_to_disk(&state.config.state_file, &current)?;
        current.clone()
    };
    Ok(Json(next_state))
}

async fn remove_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<ProjectIdRequest>,
) -> Result<Json<WorkbenchState>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    stop_terminals_for_project(&state.terminals, &request.project_id)?;
    let next_state = {
        let mut current = state.state_store.lock().map_err(lock_error)?;
        current
            .projects
            .retain(|project| project.id != request.project_id);
        if current.active_project_id.as_deref() == Some(&request.project_id) {
            current.active_project_id = current.projects.first().map(|project| project.id.clone());
        }
        save_state_to_disk(&state.config.state_file, &current)?;
        current.clone()
    };
    Ok(Json(next_state))
}

async fn open_project_window(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Result<StatusCode, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    Ok(StatusCode::NO_CONTENT)
}

async fn open_project_folder(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<ProjectIdRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    let path = {
        let current = state.state_store.lock().map_err(lock_error)?;
        let project = current
            .projects
            .iter()
            .find(|project| project.id == request.project_id)
            .ok_or_else(|| ApiError::bad_request("项目不存在"))?;
        PathBuf::from(&project.path)
    };
    if !path.exists() || !path.is_dir() {
        return Err(ApiError::bad_request("项目路径不存在"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn terminal_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<TerminalStartRequest>,
) -> Result<Json<TerminalStarted>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    Ok(Json(start_terminal_session(
        &state,
        request.session_id,
        request.project_id,
        request.cols,
        request.rows,
    )?))
}

async fn terminal_write(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<TerminalWriteRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    send_terminal_control(
        &state.terminals,
        &request.session_id,
        TerminalControl::Write(request.data),
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn terminal_resize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<TerminalResizeRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    send_terminal_control(
        &state.terminals,
        &request.session_id,
        TerminalControl::Resize {
            cols: request.cols,
            rows: request.rows,
        },
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn terminal_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<TerminalStopRequest>,
) -> Result<StatusCode, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    stop_terminal_session(&state.terminals, &request.session_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn save_pasted_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<SavePastedImageRequest>,
) -> Result<Json<String>, ApiError> {
    authorize(&state.config, &headers, query.token.as_deref())?;
    Ok(Json(save_pasted_image_to_disk(
        request.mime_type,
        request.bytes,
    )?))
}

async fn events_ws(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(error) = authorize(&state.config, &headers, query.token.as_deref()) {
        return error.into_response();
    }

    ws.on_upgrade(move |socket| events_socket(socket, state.events.subscribe()))
}

async fn events_socket(socket: WebSocket, mut events: broadcast::Receiver<ServerEvent>) {
    let (mut sender, mut receiver) = socket.split();
    let close_reader = tokio::spawn(async move { while receiver.next().await.is_some() {} });

    loop {
        match events.recv().await {
            Ok(event) => {
                let message = match event {
                    ServerEvent::TerminalOutput(payload) => {
                        serde_json::to_string(&ServerEventMessage {
                            event_type: "terminal-output",
                            payload,
                        })
                    }
                    ServerEvent::TerminalExit(payload) => {
                        serde_json::to_string(&ServerEventMessage {
                            event_type: "terminal-exit",
                            payload,
                        })
                    }
                };
                let Ok(message) = message else {
                    continue;
                };
                if sender.send(Message::Text(message)).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }

    close_reader.abort();
}

fn start_terminal_session(
    state: &AppState,
    session_id: String,
    project_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalStarted, ApiError> {
    let cwd = resolve_terminal_cwd(&state.state_store, project_id.as_deref())?;
    if state
        .terminals
        .lock()
        .map_err(lock_error)?
        .contains_key(&session_id)
    {
        return Err(ApiError::bad_request("终端会话已存在"));
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
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let mut command = CommandBuilder::new(program);
    for arg in args {
        command.arg(arg);
    }
    configure_terminal_environment(&mut command);
    command.cwd(cwd.clone());

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| ApiError::internal(format!("启动本地终端失败：{error}")))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let master = pair.master;
    let (control_tx, control_rx) = mpsc::channel::<TerminalControl>();
    let output_session_id = session_id.clone();
    let exit_session_id = session_id.clone();
    let events_for_output = state.events.clone();
    let events_for_exit = state.events.clone();

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
                Ok(size) => emit_terminal_output(
                    &events_for_output,
                    &output_session_id,
                    &mut pending_utf8,
                    &buffer[..size],
                ),
                Err(_) => break,
            }
        }
        flush_terminal_output(&events_for_output, &output_session_id, &mut pending_utf8);
        let _ = events_for_exit.send(ServerEvent::TerminalExit(TerminalExit {
            session_id: exit_session_id,
            code: None,
        }));
    });

    state.terminals.lock().map_err(lock_error)?.insert(
        session_id.clone(),
        TerminalSession {
            project_id,
            child,
            control_tx,
        },
    );

    Ok(TerminalStarted {
        session_id,
        shell: shell_label,
        cwd: path_to_string(&cwd),
        windows_build_number: None,
    })
}

fn send_terminal_control(
    terminals: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: &str,
    control: TerminalControl,
) -> Result<(), ApiError> {
    let control_tx = {
        let sessions = terminals.lock().map_err(lock_error)?;
        sessions
            .get(session_id)
            .map(|session| session.control_tx.clone())
            .ok_or_else(|| ApiError::not_found("终端会话不存在"))?
    };
    control_tx
        .send(control)
        .map_err(|_| ApiError::not_found("终端会话已关闭"))
}

fn stop_terminal_session(
    terminals: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: &str,
) -> Result<(), ApiError> {
    let session = terminals.lock().map_err(lock_error)?.remove(session_id);
    if let Some(session) = session {
        stop_detached_terminal_session(session);
    }
    Ok(())
}

fn stop_terminals_for_project(
    terminals: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    project_id: &str,
) -> Result<(), ApiError> {
    let sessions = {
        let mut current = terminals.lock().map_err(lock_error)?;
        let matching = current
            .iter()
            .filter_map(|(session_id, session)| {
                if session.project_id.as_deref() == Some(project_id) {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        matching
            .into_iter()
            .filter_map(|session_id| current.remove(&session_id))
            .collect::<Vec<_>>()
    };

    for session in sessions {
        stop_detached_terminal_session(session);
    }
    Ok(())
}

fn stop_detached_terminal_session(mut session: TerminalSession) {
    let _ = session.control_tx.send(TerminalControl::Stop);
    let _ = session.child.kill();
}

fn emit_terminal_output(
    events: &broadcast::Sender<ServerEvent>,
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
                emit_terminal_text(events, session_id, data);
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    let data = String::from_utf8_lossy(&pending_utf8[..valid_up_to]).to_string();
                    pending_utf8.drain(..valid_up_to);
                    emit_terminal_text(events, session_id, data);
                    continue;
                }

                if let Some(error_len) = error.error_len() {
                    let data = String::from_utf8_lossy(&pending_utf8[..error_len]).to_string();
                    pending_utf8.drain(..error_len);
                    emit_terminal_text(events, session_id, data);
                    continue;
                }

                return;
            }
        }
    }
}

fn flush_terminal_output(
    events: &broadcast::Sender<ServerEvent>,
    session_id: &str,
    pending_utf8: &mut Vec<u8>,
) {
    if pending_utf8.is_empty() {
        return;
    }

    let data = String::from_utf8_lossy(pending_utf8).to_string();
    pending_utf8.clear();
    emit_terminal_text(events, session_id, data);
}

fn emit_terminal_text(events: &broadcast::Sender<ServerEvent>, session_id: &str, data: String) {
    if data.is_empty() {
        return;
    }

    let _ = events.send(ServerEvent::TerminalOutput(TerminalOutput {
        session_id: session_id.to_string(),
        data,
    }));
}

fn save_pasted_image_to_disk(mime_type: String, bytes: Vec<u8>) -> Result<String, ApiError> {
    if bytes.is_empty() {
        return Err(ApiError::bad_request("剪贴板图片为空"));
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(ApiError::bad_request("剪贴板图片过大，无法临时保存"));
    }

    let extension = pasted_image_extension(&mime_type)
        .ok_or_else(|| ApiError::bad_request(format!("不支持的图片类型：{mime_type}")))?;
    let dir = env::temp_dir().join("code-terminal").join("pasted-images");
    fs::create_dir_all(&dir).map_err(|error| ApiError::internal(error.to_string()))?;
    let path = dir.join(format!("paste-{}.{}", Uuid::new_v4(), extension));
    fs::write(&path, bytes).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(path_to_string(&path))
}

fn load_state_from_disk(path: &Path) -> Result<WorkbenchState, String> {
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

fn save_state_to_disk(path: &Path, state: &WorkbenchState) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| ApiError::internal(error.to_string()))?;
    }
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    fs::write(path, content).map_err(|error| ApiError::internal(error.to_string()))
}

fn normalize_project_path(path: &str) -> Result<String, ApiError> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(ApiError::bad_request("目录不存在"));
    }
    if !path.is_dir() {
        return Err(ApiError::bad_request("请选择目录"));
    }
    canonicalize_clean(&path).map(|path| path_to_string(&path))
}

fn directory_listing(path: Option<&str>) -> Result<DirectoryListing, ApiError> {
    let path = match path.map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => normalize_directory_path(path)?,
        None => env::current_dir()
            .map_err(|error| ApiError::internal(error.to_string()))
            .and_then(|path| canonicalize_clean(&path))?,
    };
    let parent_path = path.parent().and_then(|parent| {
        canonicalize_clean(parent)
            .ok()
            .map(|parent| path_to_string(&parent))
    });
    let mut entries = fs::read_dir(&path)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .filter_map(|entry| directory_entry(entry.ok()?))
        .collect::<Vec<_>>();

    entries.sort_by_key(|entry| entry.name.to_ascii_lowercase());

    Ok(DirectoryListing {
        path: path_to_string(&path),
        parent_path,
        entries,
    })
}

fn directory_entry(entry: fs::DirEntry) -> Option<DirectoryEntry> {
    let file_type = entry.file_type().ok()?;
    if !file_type.is_dir() {
        return None;
    }

    let name = entry.file_name().to_string_lossy().to_string();
    let path = canonicalize_clean(&entry.path()).ok()?;
    Some(DirectoryEntry {
        name,
        path: path_to_string(&path),
    })
}

fn normalize_directory_path(path: &str) -> Result<PathBuf, ApiError> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(ApiError::bad_request("目录不存在"));
    }
    if !path.is_dir() {
        return Err(ApiError::bad_request("请选择目录"));
    }
    canonicalize_clean(&path)
}

fn normalize_new_directory_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("请输入文件夹名称"));
    }
    if name == "." || name == ".." {
        return Err(ApiError::bad_request("文件夹名称无效"));
    }
    if name.chars().any(|character| {
        character == '/' || character == '\\' || character.is_control()
    }) {
        return Err(ApiError::bad_request("文件夹名称不能包含路径分隔符"));
    }

    Ok(name.to_string())
}

fn resolve_terminal_cwd(
    store: &Arc<Mutex<WorkbenchState>>,
    project_id: Option<&str>,
) -> Result<PathBuf, ApiError> {
    if let Some(project_id) = project_id {
        let state = store.lock().map_err(lock_error)?;
        let project = state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| ApiError::bad_request("项目不存在"))?;
        let path = PathBuf::from(&project.path);
        if !path.exists() || !path.is_dir() {
            return Err(ApiError::bad_request("项目路径不存在"));
        }
        return canonicalize_clean(&path);
    }

    env::current_dir()
        .map_err(|error| ApiError::internal(error.to_string()))
        .map(clean_windows_verbatim_path)
}

fn canonicalize_clean(path: &Path) -> Result<PathBuf, ApiError> {
    path.canonicalize()
        .map(clean_windows_verbatim_path)
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn normalize_existing_path(path: &str) -> String {
    let path = PathBuf::from(clean_windows_verbatim_path_str(path));
    if path.exists() {
        match canonicalize_clean(&path) {
            Ok(path) => path_to_string(&path),
            Err(_) => path_to_string(&path),
        }
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

fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Project")
        .to_string()
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
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    (shell.clone(), Vec::new(), shell)
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    command.env("POWERSHELL_UPDATECHECK", "Off");
}

#[cfg(windows)]
fn powershell_startup_script() -> &'static str {
    "$ProgressPreference='SilentlyContinue';try{$c=Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue;if($c){if($c.Parameters.ContainsKey('PredictionSource')){Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue};if($c.Parameters.ContainsKey('BellStyle')){Set-PSReadLineOption -BellStyle None -ErrorAction SilentlyContinue}}}catch{}"
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

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> ApiError {
    ApiError::internal(error.to_string())
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "未授权".into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        (self.status, headers, self.message).into_response()
    }
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        ApiError::internal(message)
    }
}
