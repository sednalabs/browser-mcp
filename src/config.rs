//! Operator-supplied process configuration; never taken from tool arguments.

use std::{ffi::OsString, path::PathBuf, time::Duration};

/// Configures the single worker owned by this MCP process.
#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub node: OsString,
    pub worker_path: PathBuf,
    pub call_timeout: Duration,
    pub cancellation_grace: Duration,
    pub max_response_bytes: usize,
    /// HTTP workers clear inherited SEDNA_BROWSER_* overrides before starting.
    pub isolate_browser_environment: bool,
    pub browser_config: Option<PathBuf>,
}

impl WorkerConfig {
    /// Resolves a worker alongside the binary or in the original source tree.
    ///
    /// The current working directory is deliberately not searched: opening a
    /// project must not implicitly replace the program this server executes.
    pub fn resolve(
        explicit_worker: Option<PathBuf>,
        explicit_node: Option<OsString>,
        timeout_seconds: u64,
    ) -> Result<Self, String> {
        if !(1..=600).contains(&timeout_seconds) {
            return Err("--timeout must be between 1 and 600 seconds".into());
        }
        let requested =
            explicit_worker.or_else(|| std::env::var_os("SEDNA_BROWSER_WORKER").map(PathBuf::from));
        let worker_path = if let Some(path) = requested {
            path
        } else {
            let mut candidates = Vec::new();
            if let Ok(exe) = std::env::current_exe()
                && let Some(parent) = exe.parent()
            {
                candidates.push(parent.join("worker/main.mjs"));
                candidates.push(parent.join("../share/sedna-browser-mcp/worker/main.mjs"));
            }
            candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("worker/main.mjs"));
            candidates.into_iter().find(|path| path.is_file()).ok_or(
                "Playwright worker not found; pass --worker /absolute/path/to/worker/main.mjs",
            )?
        };
        if !worker_path.is_file() {
            return Err(format!(
                "worker file does not exist: {}",
                worker_path.display()
            ));
        }
        let worker_path = worker_path
            .canonicalize()
            .map_err(|error| format!("cannot resolve worker path: {error}"))?;
        Ok(Self {
            node: explicit_node
                .or_else(|| std::env::var_os("SEDNA_BROWSER_NODE"))
                .unwrap_or_else(|| "node".into()),
            worker_path,
            call_timeout: Duration::from_secs(timeout_seconds),
            cancellation_grace: Duration::from_secs(30),
            max_response_bytes: 32 * 1024 * 1024,
            isolate_browser_environment: false,
            browser_config: None,
        })
    }
}
