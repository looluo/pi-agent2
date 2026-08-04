use std::{
    fs::{self, File, OpenOptions},
    io::{self, Cursor, Read, Seek},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, WebviewWindow, WindowEvent};
use zip::ZipArchive;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const APP_TITLE: &str = "Pi Agent App";
const PREFERRED_PORT: u16 = 30141;
const RUNTIME_VERSION: &str = "node-v24.14.1-next-runtime-v4";
const RUNTIME_ZIP: &[u8] = include_bytes!("../resources/runtime-bundle.zip");

pub fn run() {
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_slot_for_setup = Arc::clone(&child_slot);
    let child_slot_for_close = Arc::clone(&child_slot);

    tauri::Builder::default()
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            window.set_title(APP_TITLE)?;
            thread::spawn(move || {
                if let Err(error) = start_pi_web(window.clone(), child_slot_for_setup) {
                    show_startup_error(&window, &error);
                }
            });
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                kill_child(&child_slot_for_close);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pi Agent App");
}

fn start_pi_web(window: WebviewWindow, child_slot: Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    show_startup_status(&window, "Preparing runtime bundle...");
    let runtime_dir = ensure_runtime().map_err(|error| format!("Failed to prepare runtime bundle: {error}"))?;
    let log_path = runtime_dir.join("pi-web-server.log");

    show_startup_status(&window, "Starting local Pi Web server...");
    let port = choose_port().map_err(|error| format!("Failed to choose a loopback port: {error}"))?;
    let node_exe = find_node_exe(&runtime_dir).ok_or_else(|| format!("node.exe was not found under {}", runtime_dir.display()))?;
    let app_dir = runtime_dir.join("app");
    let server_js = app_dir.join("server.js");
    if !server_js.exists() {
        return Err(format!("Next.js standalone server was not found at {}", server_js.display()));
    }

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open log file {}: {error}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|error| format!("Failed to clone log handle: {error}"))?;

    let mut command = Command::new(&node_exe);
    command
        .arg(&server_js)
        .current_dir(&app_dir)
        .env("NODE_ENV", "production")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to launch {}: {error}", node_exe.display()))?;
    *child_slot.lock().map_err(|_| "Local Pi Web server child lock was poisoned".to_string())? = Some(child);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            let url = format!("http://127.0.0.1:{port}");
            show_startup_status(&window, "Opening Pi Agent App...");
            let parsed_url = url.parse().map_err(|error| format!("Invalid startup URL: {error}"))?;
            if let Err(error) = window.navigate(parsed_url) {
                kill_child(&child_slot);
                return Err(format!("Failed to navigate desktop window: {error}"));
            }
            return Ok(());
        }
        if let Some(status) = child_status(&child_slot).map_err(|error| format!("Failed to poll Local Pi Web server: {error}"))? {
            clear_child(&child_slot);
            return Err(format!(
                "Local Pi Web server exited early with status {status}. See log: {}",
                log_path.display()
            ));
        }
        if Instant::now() >= deadline {
            kill_child(&child_slot);
            return Err(format!(
                "Timed out waiting for Local Pi Web server on 127.0.0.1:{port}. See log: {}",
                log_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn choose_port() -> io::Result<u16> {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        let port = listener.local_addr()?.port();
        drop(listener);
        return Ok(port);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn child_status(child_slot: &Arc<Mutex<Option<Child>>>) -> io::Result<Option<std::process::ExitStatus>> {
    let mut guard = child_slot
        .lock()
        .map_err(|_| io::Error::other("Local Pi Web server child lock was poisoned"))?;
    match guard.as_mut() {
        Some(child) => child.try_wait(),
        None => Ok(None),
    }
}

fn clear_child(child_slot: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = child_slot.lock() {
        *guard = None;
    }
}

fn kill_child(child_slot: &Arc<Mutex<Option<Child>>>) {
    let Ok(mut guard) = child_slot.lock() else {
        return;
    };
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn ensure_runtime() -> io::Result<PathBuf> {
    let base = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("pi-agent")
        .join("runtime")
        .join(RUNTIME_VERSION);
    let marker = base.join(".ready");
    if marker.exists() && base.join("app").join("server.js").exists() && find_node_exe(&base).is_some() {
        return Ok(base);
    }

    if base.exists() {
        fs::remove_dir_all(&base)?;
    }
    fs::create_dir_all(&base)?;
    extract_zip_bytes(RUNTIME_ZIP, &base)?;

    let node_zip = base.join("node").join("node-v24.14.1-win-x64.zip");
    if node_zip.exists() {
        extract_zip_file(&node_zip, &base.join("node"))?;
    }

    fs::write(marker, b"ready")?;
    Ok(base)
}

fn find_node_exe(runtime_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        runtime_dir.join("node").join("node.exe"),
        runtime_dir.join("node").join("node-v24.14.1-win-x64").join("node.exe"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn extract_zip_bytes(bytes: &[u8], destination: &Path) -> io::Result<()> {
    let cursor = Cursor::new(bytes);
    extract_zip_archive(ZipArchive::new(cursor).map_err(zip_to_io)?, destination)
}

fn extract_zip_file(path: &Path, destination: &Path) -> io::Result<()> {
    let file = File::open(path)?;
    extract_zip_archive(ZipArchive::new(file).map_err(zip_to_io)?, destination)
}

fn extract_zip_archive<R: Read + Seek>(mut archive: ZipArchive<R>, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(zip_to_io)?;
        let Some(enclosed_name) = file.enclosed_name().map(|path| path.to_owned()) else {
            continue;
        };
        let out_path = destination.join(enclosed_name);
        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out_file = File::create(&out_path)?;
            io::copy(&mut file, &mut out_file)?;
        }
    }
    Ok(())
}

fn zip_to_io(error: zip::result::ZipError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn show_startup_status(window: &WebviewWindow, message: &str) {
    let script = format!("window.setPiAgentStatus && window.setPiAgentStatus({});", js_string(message));
    let _ = window.eval(&script);
}

fn show_startup_error(window: &WebviewWindow, message: &str) {
    let script = format!("window.setPiAgentError && window.setPiAgentError({});", js_string(message));
    let _ = window.eval(&script);
}

fn js_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
