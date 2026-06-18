use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{mpsc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct TerminalRegistry(Mutex<HashMap<String, TerminalSession>>);

struct TerminalSession {
    child: Box<dyn PtyChild + Send>,
    control_tx: mpsc::Sender<TerminalControl>,
}

enum TerminalControl {
    Write(String),
    Resize { cols: u16, rows: u16 },
    Stop,
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

#[tauri::command]
fn terminal_start(
    app: AppHandle,
    terminals: State<'_, TerminalRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalStarted, String> {
    if terminals
        .0
        .lock()
        .map_err(lock_error)?
        .contains_key(&session_id)
    {
        return Err("终端会话已存在".into());
    }

    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
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
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => emit_terminal_output(
                    &app_for_thread,
                    &output_session_id,
                    &mut pending_utf8,
                    &buffer[..size],
                ),
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

    terminals.0.lock().map_err(lock_error)?.insert(
        session_id.clone(),
        TerminalSession { child, control_tx },
    );

    Ok(TerminalStarted {
        session_id,
        shell: shell_label,
        cwd: cwd.to_string_lossy().to_string(),
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
fn terminal_stop(
    terminals: State<'_, TerminalRegistry>,
    session_id: String,
) -> Result<(), String> {
    let session = terminals.0.lock().map_err(lock_error)?.remove(&session_id);
    if let Some(mut session) = session {
        let _ = session.control_tx.send(TerminalControl::Stop);
        let _ = session.child.kill();
    }
    Ok(())
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

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    error.to_string()
}

// Tauri builder 里这样注册：
//
// tauri::Builder::default()
//     .manage(TerminalRegistry::default())
//     .invoke_handler(tauri::generate_handler![
//         terminal_start,
//         terminal_write,
//         terminal_resize,
//         terminal_stop,
//     ])
//     .run(tauri::generate_context!())
//     .expect("error while running tauri application");

