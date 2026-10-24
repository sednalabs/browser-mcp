//! A bounded actor keeps browser calls ordered through cancellation and capture.

use crate::{WorkerConfig, process::WorkerProcess};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const MAX_REQUEST_BYTES: usize = 128 * 1024;
const QUEUE_CAPACITY: usize = 32;

struct Operation {
    id: String,
    method: String,
    params: Value,
    cancellation: CancellationToken,
    response: oneshot::Sender<Result<Value, String>>,
}

struct Supervision {
    handle: Option<tokio::task::JoinHandle<Result<(), String>>>,
    outcome: Option<Result<(), String>>,
}

struct Inner {
    sender: mpsc::Sender<Operation>,
    next_id: AtomicU64,
    shutdown: CancellationToken,
    actor: Mutex<Supervision>,
}

/// Owns one lazy worker. A failed worker is never silently restarted or replayed.
#[derive(Clone)]
pub struct WorkerClient(Arc<Inner>);

impl WorkerClient {
    pub fn new(config: WorkerConfig) -> Self {
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let shutdown = CancellationToken::new();
        let actor = tokio::spawn(run_actor(config, receiver, shutdown.clone()));
        Self(Arc::new(Inner {
            sender,
            next_id: AtomicU64::new(1),
            shutdown,
            actor: Mutex::new(Supervision {
                handle: Some(actor),
                outcome: None,
            }),
        }))
    }

    /// Calls the worker; dropping this future requests cooperative cancellation.
    /// The actor retains the operation until its response or cleanup deadline.
    pub async fn call(
        &self,
        method: String,
        params: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        let size = serde_json::to_vec(&params)
            .map_err(|error| error.to_string())?
            .len();
        if size > MAX_REQUEST_BYTES {
            return Err(
                "Browser arguments exceed the 128 KiB request limit; nothing was dispatched."
                    .into(),
            );
        }
        let operation_cancellation = cancellation.child_token();
        let _cancel_on_drop = operation_cancellation.clone().drop_guard();
        let (response, result) = oneshot::channel();
        let operation = Operation {
            id: format!("op-{}", self.0.next_id.fetch_add(1, Ordering::Relaxed)),
            method,
            params,
            cancellation: operation_cancellation.clone(),
            response,
        };
        if self.0.shutdown.is_cancelled() {
            return Err("Browser host is shutting down; nothing was dispatched.".into());
        }
        if operation_cancellation.is_cancelled() {
            return Err("Browser call cancelled before admission; nothing was dispatched.".into());
        }
        self.0.sender.try_send(operation).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => format!(
                "Browser operation queue is full ({QUEUE_CAPACITY} pending calls); nothing was dispatched. Wait for existing operation receipts before another request."
            ),
            mpsc::error::TrySendError::Closed(_) => "Browser worker is unavailable; nothing was dispatched.".to_string(),
        })?;
        result.await.map_err(|_| "Browser worker stopped before returning a receipt. Do not assume the action was unapplied.".to_string())?
    }

    /// Cancels pending work, requests browser cleanup and waits for the child.
    pub async fn shutdown(&self) -> Result<(), String> {
        self.0.shutdown.cancel();
        // Keep the handle in shared state while awaiting it. Cancellation of a
        // shutdown waiter must not detach it or turn a later join into false
        // success. Concurrent lease expiry/server shutdown share this outcome.
        let mut state = self.0.actor.lock().await;
        if let Some(outcome) = &state.outcome {
            return outcome.clone();
        }
        let outcome = if let Some(actor) = state.handle.as_mut() {
            match tokio::time::timeout(Duration::from_secs(75), &mut *actor).await {
                Ok(result) => result
                    .map_err(|error| format!("browser worker supervisor failed: {error}"))
                    .and_then(|outcome| outcome),
                Err(_) => {
                    actor.abort();
                    let _ = actor.await;
                    Err("browser worker cleanup exceeded 75 seconds; forced process cleanup was requested".into())
                }
            }
        } else {
            Ok(())
        };
        state.handle = None;
        state.outcome = Some(outcome.clone());
        outcome
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn run_actor(
    config: WorkerConfig,
    mut operations: mpsc::Receiver<Operation>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let mut process = None;
    let mut failure = None;
    let mut cleanup_error = None;
    loop {
        let operation = tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            operation = operations.recv() => match operation {
                Some(operation) => operation,
                None => break,
            },
        };
        if operation.cancellation.is_cancelled() {
            let _ = operation.response.send(Err(
                "Browser call cancelled while queued; nothing was dispatched.".into(),
            ));
            continue;
        }
        if let Some(message) = &failure {
            let _ = operation.response.send(Err(format!("Browser worker is unavailable: {message}. Start a new server explicitly; calls are never replayed.")));
            continue;
        }
        if process.is_none() {
            match WorkerProcess::spawn(&config) {
                Ok(started) => process = Some(started),
                Err(message) => {
                    failure = Some(message.clone());
                    let _ = operation.response.send(Err(message));
                    continue;
                }
            }
        }
        let Some(running) = process.as_mut() else {
            break;
        };
        let result = running
            .execute(
                &operation.id,
                &operation.method,
                operation.params,
                &operation.cancellation,
                &shutdown,
                &config,
            )
            .await;
        if let Err(message) = &result {
            failure = Some(message.clone());
            if let Some(mut running) = process.take() {
                if let Err(error) = running.terminate().await {
                    cleanup_error = Some(error);
                }
            }
        }
        let _ = operation.response.send(result);
    }
    operations.close();
    while let Some(operation) = operations.recv().await {
        let _ = operation.response.send(Err(
            "Browser host stopped before dispatching this queued call.".into(),
        ));
    }
    if let Some(mut running) = process {
        if let Err(error) = running.close().await {
            cleanup_error = Some(error);
        }
    }
    match cleanup_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
