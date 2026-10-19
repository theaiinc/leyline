use std::{
    env,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3417;

/// Result of `spawn_if_needed`: whether an existing API was reused or a new
/// sidecar process was spawned (and still needs a readiness wait).
pub enum StartOutcome {
    Reused,
    Spawned,
    Waiting,
}

pub struct SidecarManager {
    child: Option<Child>,
    host: String,
    port: u16,
    /// Per-user config directory (Tauri's `app_config_dir()`), where packaged
    /// builds read the sidecar's `.env` from. Never bundled with the app.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    config_dir: Option<PathBuf>,
}

impl SidecarManager {
    pub fn new(config_dir: Option<PathBuf>) -> Self {
        Self {
            child: None,
            config_dir,
            host: env::var("LEYLINE_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string()),
            port: env::var("PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_PORT),
        }
    }

    pub fn endpoint(&self) -> (String, u16) {
        (self.host.clone(), self.port)
    }

    /// Spawn the sidecar unless an API is already reachable. Returns quickly;
    /// callers that spawned must poll `endpoint_ready` themselves (see
    /// `main.rs`), which keeps long waits out of any mutex guard.
    pub fn spawn_if_needed(&mut self, resource_dir: Option<PathBuf>) -> io::Result<StartOutcome> {
        self.reap_exited_child();

        if self.is_ready() {
            println!("[Leyline] Internal API already running; reusing it");
            return Ok(StartOutcome::Reused);
        }

        if self.child.is_some() {
            return Ok(StartOutcome::Waiting);
        }

        let entrypoint = self.resolve_entrypoint(resource_dir.clone())?;
        let command_name = self.resolve_command();
        // GUI-launched apps often don't inherit the shell PATH, so append the
        // usual user/Homebrew bin dirs. join_paths uses the platform separator
        // (":" on Unix, ";" on Windows, where drive letters contain ":").
        let mut path_entries: Vec<PathBuf> = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect())
            .unwrap_or_default();
        if cfg!(target_os = "macos") {
            path_entries.push(PathBuf::from("/opt/homebrew/bin"));
            path_entries.push(PathBuf::from("/usr/local/bin"));
        }
        if let Some(home) = env::var_os("HOME") {
            let home = PathBuf::from(home);
            path_entries.push(home.join(".local").join("bin"));
            path_entries.push(home.join(".volta").join("bin"));
        }
        let path_entries = env::join_paths(path_entries)
            .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default());

        println!(
            "[Leyline] Starting internal API sidecar: {} {}",
            command_name.display(),
            entrypoint.display()
        );
        let mut command = Command::new(command_name);
        command
            .arg(&entrypoint)
            .env("LEYLINE_HOST", &self.host)
            .env("PORT", self.port.to_string())
            .env("PATH", path_entries)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());

        // Release builds use the Windows GUI subsystem; without this flag each
        // sidecar launch would pop up a console window.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        // In development, load the workspace .env just like `npm start`.
        // Packaged builds must never ship a .env (it would leak whoever built
        // the app's keys), so they read runtime config from a per-user file
        // instead: <app_config_dir>/.env, e.g.
        //   macOS:   ~/Library/Application Support/com.theaiinc.leyline/.env
        //   Windows: %APPDATA%\com.theaiinc.leyline\.env
        // The path is handed to the Node API via LEYLINE_ENV_FILE (src/config.ts);
        // an explicit LEYLINE_ENV_FILE in the launching environment wins.
        #[cfg(debug_assertions)]
        if let Some(project_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
            command.current_dir(project_root);
        }
        #[cfg(not(debug_assertions))]
        if let Some(dir) = self.config_dir.as_ref() {
            prepare_user_config_dir(dir, resource_dir.as_deref());
            if env::var_os("LEYLINE_ENV_FILE").is_none() {
                command.env("LEYLINE_ENV_FILE", dir.join(".env"));
            }
            command.current_dir(dir);
        }

        let child = command.spawn()?;
        self.child = Some(child);
        Ok(StartOutcome::Spawned)
    }

    #[cfg(test)]
    fn ensure_started_with_timeout(
        &mut self,
        resource_dir: Option<PathBuf>,
        timeout: Duration,
    ) -> io::Result<()> {
        match self.spawn_if_needed(resource_dir)? {
            StartOutcome::Reused => Ok(()),
            StartOutcome::Waiting => {
                if self.wait_until_ready(timeout) {
                    Ok(())
                } else {
                    self.stop();
                    Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "Leyline internal API did not become ready on {}:{}",
                            self.host, self.port
                        ),
                    ))
                }
            }
            StartOutcome::Spawned => {
                if self.wait_until_ready(timeout) {
                    Ok(())
                } else {
                    self.stop();
                    Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "Leyline internal API did not become ready on {}:{}",
                            self.host, self.port
                        ),
                    ))
                }
            }
        }
    }

    fn resolve_entrypoint(&self, resource_dir: Option<PathBuf>) -> io::Result<PathBuf> {
        if let Ok(value) = env::var("LEYLINE_SIDECAR_ENTRYPOINT") {
            let path = PathBuf::from(value);
            if path.exists() {
                return Ok(path);
            }
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "LEYLINE_SIDECAR_ENTRYPOINT does not exist: {}",
                    path.display()
                ),
            ));
        }

        let mut candidates = Vec::new();
        if let Some(dir) = resource_dir {
            candidates.push(dir.join("_up_").join("dist").join("index.js"));
            candidates.push(dir.join("dist").join("index.js"));
        }
        if let Ok(current_dir) = env::current_dir() {
            candidates.push(current_dir.join("dist").join("index.js"));
        }
        if let Ok(executable) = env::current_exe() {
            if let Some(parent) = executable.parent() {
                candidates.push(parent.join("dist").join("index.js"));
            }
        }

        candidates.into_iter().find(|path| path.exists()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not locate Leyline dist/index.js; run npm run build or set LEYLINE_SIDECAR_ENTRYPOINT",
            )
        })
    }

    #[cfg(test)]
    fn with_endpoint(port: u16) -> Self {
        Self {
            child: None,
            config_dir: None,
            host: DEFAULT_HOST.to_string(),
            port,
        }
    }

    pub fn is_ready(&self) -> bool {
        endpoint_ready(&self.host, self.port)
    }

    #[cfg(test)]
    fn wait_until_ready(&self, timeout: Duration) -> bool {
        wait_until_endpoint_ready(&self.host, self.port, timeout)
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn reap_exited_child(&mut self) {
        let exited = self
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some();
        if exited {
            self.child = None;
            eprintln!("[Leyline] Internal API sidecar exited; it will be restarted.");
        }
    }

    fn resolve_command(&self) -> PathBuf {
        if let Ok(value) = env::var("LEYLINE_SIDECAR_COMMAND") {
            return PathBuf::from(value);
        }

        // A Node runtime shipped next to the app executable wins (the MSIX
        // Store build puts node.exe there, see .github/workflows/msix.yml),
        // then well-known system locations, then whatever `node` is on PATH.
        let node_file = format!("node{}", env::consts::EXE_SUFFIX);
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(executable) = env::current_exe() {
            if let Some(parent) = executable.parent() {
                candidates.push(parent.join(&node_file));
            }
        }
        if cfg!(unix) {
            candidates.extend(
                [
                    "/opt/homebrew/bin/node",
                    "/usr/local/bin/node",
                    "/usr/bin/node",
                ]
                .iter()
                .map(PathBuf::from),
            );
        }
        candidates
            .into_iter()
            .find(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from(node_file))
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Create the per-user config dir and drop a key-names-only `.env.example`
/// there (copied from the bundled resource) so users know what to fill in.
/// Failures are logged, never fatal: the API still starts without config.
#[cfg(not(debug_assertions))]
fn prepare_user_config_dir(dir: &std::path::Path, resource_dir: Option<&std::path::Path>) {
    if let Err(error) = std::fs::create_dir_all(dir) {
        eprintln!(
            "[Leyline] Could not create config dir {}: {error}",
            dir.display()
        );
        return;
    }
    let example = dir.join(".env.example");
    if example.exists() {
        return;
    }
    let Some(resource_dir) = resource_dir else {
        return;
    };
    for candidate in [
        resource_dir.join("_up_").join(".env.example"),
        resource_dir.join(".env.example"),
    ] {
        if candidate.exists() {
            let _ = std::fs::copy(&candidate, &example);
            break;
        }
    }
}

pub fn endpoint_ready(host: &str, port: u16) -> bool {
    let address = format!("{host}:{port}");
    let Some(address) = address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
    else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(150)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200 ") && response.contains("\"status\":\"ok\"")
}

pub fn wait_until_endpoint_ready(host: &str, port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if endpoint_ready(host, port) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::SidecarManager;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        process::Command,
        thread,
        time::Duration,
    };

    fn start_health_server(requests: usize) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test port");
        let port = listener.local_addr().expect("test address").port();
        let handle = thread::spawn(move || {
            for _ in 0..requests {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut request = [0_u8; 256];
                let _ = stream.read(&mut request);
                let body = "{\"status\":\"ok\"}";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, handle)
    }

    #[test]
    fn detects_an_already_running_internal_api_without_spawning() {
        let (port, server) = start_health_server(1);
        let manager = SidecarManager::with_endpoint(port);

        assert!(manager.is_ready());
        server.join().expect("health server thread");
    }

    #[test]
    fn repeated_readiness_checks_are_safe_for_an_existing_process() {
        let (port, server) = start_health_server(2);
        let mut manager = SidecarManager::with_endpoint(port);

        manager
            .ensure_started_with_timeout(None, Duration::from_millis(10))
            .expect("existing endpoint should be reused");
        manager
            .ensure_started_with_timeout(None, Duration::from_millis(10))
            .expect("second check should still reuse endpoint");
        assert!(manager.child.is_none());
        server.join().expect("health server thread");
    }

    #[test]
    fn readiness_timeout_returns_false_when_port_stays_closed() {
        let manager = SidecarManager::with_endpoint(9);

        assert!(!manager.wait_until_ready(Duration::from_millis(10)));
    }

    #[test]
    fn clean_shutdown_terminates_a_spawned_child() {
        let mut manager = SidecarManager::with_endpoint(9);
        manager.child = Some(
            Command::new("sleep")
                .arg("60")
                .spawn()
                .expect("spawn test child"),
        );

        manager.stop();
        assert!(manager.child.is_none());
    }
}
