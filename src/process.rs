//! Bounded NDJSON transport and cleanup for an operator-selected Node process.

use crate::WorkerConfig;
use serde_json::{Value, json};
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct WorkerProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<Result<Value, String>>,
    reader: tokio::task::JoinHandle<()>,
    pending_cancel_acknowledgments: HashSet<String>,
}

impl WorkerProcess {
    pub(crate) fn spawn(config: &WorkerConfig) -> Result<Self, String> {
        let mut command = Command::new(&config.node);
        command
            .arg(&config.worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if config.isolate_browser_environment {
            for (key, _) in std::env::vars_os() {
                if key.to_str().is_some_and(|name| name.starts_with("SEDNA_BROWSER_")) {
                    command.env_remove(key);
                }
            }
            command.env("SEDNA_BROWSER_HTTP_WORKER", "true");
            if let Some(path) = &config.browser_config {
                command.env("SEDNA_BROWSER_CONFIG", path);
            }
        }
        #[cfg(unix)]
        mcp_toolkit_process::configure_child_process_group(command.as_std_mut())
            .map_err(|error| format!("cannot isolate worker process group: {error}"))?;
        let mut child = command
            .spawn()
            .map_err(|error| format!("cannot start Node browser worker: {error}"))?;
        let stdin = child.stdin.take().ok_or("worker stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("worker stdout unavailable")?;
        let (sender, responses) = mpsc::channel(2);
        let max_bytes = config.max_response_bytes;
        let reader = tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            loop {
                let line = read_frame(&mut stdout, max_bytes).await;
                let result = line.and_then(|line| {
                    serde_json::from_slice(&line)
                        .map_err(|error| format!("invalid JSON from browser worker: {error}"))
                });
                let failed = result.is_err();
                if sender.send(result).await.is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            responses,
            reader,
            pending_cancel_acknowledgments: HashSet::new(),
        })
    }

    async fn request_cancellation(&mut self, id: &str, cancel_id: &str) -> Result<(), String> {
        if self.pending_cancel_acknowledgments.len() >= 32 {
            return Err("browser worker did not acknowledge prior cancellation requests; retiring the worker without replaying actions".into());
        }
        self.send(json!({"id":cancel_id,"method":"cancel","params":{"operation_id":id}}))
            .await?;
        self.pending_cancel_acknowledgments.insert(cancel_id.into());
        Ok(())
    }

    async fn send(&mut self, request: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let stdin = self
            .stdin
            .as_mut()
            .ok_or("browser worker input is closed")?;
        timeout(Duration::from_secs(5), async {
            stdin.write_all(&bytes).await?;
            stdin.flush().await
        })
        .await
        .map_err(|_| "browser worker did not accept the request within 5 seconds".to_string())?
        .map_err(|error| format!("cannot write to browser worker: {error}"))
    }

    pub(crate) async fn execute(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
        shutdown: &CancellationToken,
        config: &WorkerConfig,
    ) -> Result<Value, String> {
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        let cancel_id = format!("cancel-{id}");
        let mut cancelled = false;
        let mut deadline = Instant::now() + config.call_timeout;
        loop {
            tokio::select! {
                biased;
                response = self.responses.recv() => {
                    let response = response.ok_or("browser worker output closed; action outcome is uncertain")??;
                    let response_id = response.get("id").and_then(Value::as_str);
                    // An operation can finish just before the worker reads its
                    // cancellation. Its ACK can therefore follow the receipt
                    // and arrive while the next operation is running.
                    if response_id.is_some_and(|id| self.pending_cancel_acknowledgments.remove(id)) { continue; }
                    if response_id != Some(id) {
                        return Err("browser worker response id did not match the active operation; action outcome is uncertain".into());
                    }
                    if let Some(result) = response.get("result") { return Ok(result.clone()); }
                    if let Some(error) = response.get("error") {
                        let message = error.get("message").and_then(Value::as_str).unwrap_or("browser worker operation failed");
                        return Ok(json!({"content":[{"type":"text","text":message}],"isError":true}));
                    }
                    return Err("browser worker response lacked result and error; action outcome is uncertain".into());
                }
                _ = cancellation.cancelled(), if !cancelled => {
                    self.request_cancellation(id, &cancel_id).await?;
                    cancelled = true;
                    deadline = Instant::now() + config.cancellation_grace;
                }
                _ = shutdown.cancelled(), if !cancelled => {
                    self.request_cancellation(id, &cancel_id).await?;
                    cancelled = true;
                    deadline = Instant::now() + config.cancellation_grace;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    if cancelled {
                        return Err("Browser operation did not settle after cancellation. Worker retired; prior action effects are uncertain and must not be replayed automatically.".into());
                    }
                    self.request_cancellation(id, &cancel_id).await?;
                    cancelled = true;
                    deadline = Instant::now() + config.cancellation_grace;
                }
            }
        }
    }

    pub(crate) async fn close(&mut self) -> Result<(), String> {
        let _ = self
            .send(json!({"id":"shutdown","method":"shutdown","params":{}}))
            .await;
        self.stdin.take();
        match timeout(Duration::from_secs(35), self.child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(_)) => Err("Worker exited unsuccessfully during cleanup; browser cleanup is unconfirmed.".into()),
            _ => self.terminate().await,
        }
    }

    pub(crate) async fn terminate(&mut self) -> Result<(), String> {
        if let Some(pid) = self.child.id() {
            #[cfg(unix)]
            if let Err(error) = mcp_toolkit_process::signal_process_group_or_process(
                pid,
                mcp_toolkit_process::ProcessSignal::Terminate,
            ) {
                eprintln!("sedna-browser-mcp: worker termination signal failed: {error}");
            }
            #[cfg(not(unix))]
            let _ = self.child.start_kill();
        }
        if matches!(
            timeout(Duration::from_secs(5), self.child.wait()).await,
            Ok(Ok(_))
        ) {
            return Ok(());
        }
        if let Some(pid) = self.child.id() {
            #[cfg(unix)]
            let _ = mcp_toolkit_process::signal_process_group_or_process(
                pid,
                mcp_toolkit_process::ProcessSignal::Kill,
            );
            let _ = pid;
        }
        let _ = self.child.start_kill();
        match timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            _ => Err("Worker termination could not be confirmed; its capacity must remain quarantined.".into()),
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(pid) = self.child.id() {
            #[cfg(unix)]
            let _ = mcp_toolkit_process::signal_process_group_or_process(
                pid,
                mcp_toolkit_process::ProcessSignal::Kill,
            );
            let _ = pid;
        }
    }
}

async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|error| format!("browser worker read failed: {error}"))?;
        if available.is_empty() {
            return Err("browser worker exited before returning a complete response; action outcome may be uncertain".into());
        }
        let ending = available.iter().position(|byte| *byte == b'\n');
        let count = ending.map_or(available.len(), |index| index + 1);
        if result.len() + count > maximum {
            return Err("browser worker response exceeded the configured output bound".into());
        }
        result.extend_from_slice(&available[..count]);
        reader.consume(count);
        if ending.is_some() {
            return Ok(result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::read_frame;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn oversized_frames_are_rejected_without_an_unbounded_read() {
        let bytes = b"123456789\n";
        let mut reader = BufReader::with_capacity(2, &bytes[..]);
        assert!(read_frame(&mut reader, 4).await.is_err());
    }

    #[tokio::test]
    async fn each_frame_is_kept_separate_across_small_reads() {
        let mut reader = BufReader::with_capacity(2, &b"{\"a\":1}\n{\"b\":2}\n"[..]);
        assert_eq!(read_frame(&mut reader, 128).await.unwrap(), b"{\"a\":1}\n");
        assert_eq!(read_frame(&mut reader, 128).await.unwrap(), b"{\"b\":2}\n");
    }
}
