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
const DEFAULT_PORT: u16 = 3000;

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

    pub fn ensure_started(&mut self, resource_dir: Option<PathBuf>) -> io::Result<()> {
        self.ensure_started_with_timeout(resource_dir, Duration::from_secs(20))
    }

    fn ensure_started_with_timeout(
        &mut self,
        resource_dir: Option<PathBuf>,
        timeout: Duration,
    ) -> io::Result<()> {
        if self.is_ready() {
            println!("[Leyline] Internal API already running; reusing it");
            return Ok(());
        }

        let entrypoint = env::var("LEYLINE_SIDECAR_ENTRYPOINT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                resource_dir
                    .clone()
                    .map(|dir| {
                        let nested = dir.join("_up_").join("dist").join("index.js");
                        if nested.exists() {
                            nested
                        } else {
                            dir.join("dist").join("index.js")
                        }
                    })
                    .unwrap_or_else(|| PathBuf::from("dist/index.js"))
            });
        let command_name = env::var("LEYLINE_SIDECAR_COMMAND")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("node"));

        println!(
            "[Leyline] Starting internal API sidecar: {} {}",
            command_name.display(),
            entrypoint.display()
        );
        let child = Command::new(command_name)
            .arg(&entrypoint)
            .env("LEYLINE_HOST", &self.host)
            .env("LEYLINE_TUNNEL_ENABLED", "false")
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?;
        self.child = Some(child);

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

    #[cfg(test)]
    fn with_endpoint(port: u16) -> Self {
        Self {
            child: None,
            host: DEFAULT_HOST.to_string(),
            port,
        }
    }

    pub fn is_ready(&self) -> bool {
        let address = format!("{}:{}", self.host, self.port);
        let Some(address) = address
            .to_socket_addrs()
            .ok()
            .and_then(|mut addresses| addresses.next())
        else {
            return false;
        };
        let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150))
        else {
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

    fn wait_until_ready(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if self.is_ready() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
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
