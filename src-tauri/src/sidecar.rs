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
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: None,
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
        let path_entries = [
            env::var("PATH").ok(),
            (cfg!(target_os = "macos")).then(|| "/opt/homebrew/bin".to_string()),
            (cfg!(target_os = "macos")).then(|| "/usr/local/bin".to_string()),
            env::var("HOME")
                .ok()
                .map(|home| format!("{home}/.local/bin")),
            env::var("HOME")
                .ok()
                .map(|home| format!("{home}/.volta/bin")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(":");

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

        // In development, load the workspace .env just like `npm start`. Packaged
        // builds get no cwd by default (Finder launches land at "/"), so they'd
        // never find provider config; point them at the bundled resource
        // directory instead, where tauri.conf.json's resources map ships a copy
        // of .env alongside dist/ and node_modules/.
        #[cfg(debug_assertions)]
        if let Some(project_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
            command.current_dir(project_root);
        }
        #[cfg(not(debug_assertions))]
        if let Some(dir) = resource_dir {
            command.current_dir(dir.join("_up_"));
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

        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ];
        candidates
            .iter()
            .map(PathBuf::from)
            .find(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from("node"))
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
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
