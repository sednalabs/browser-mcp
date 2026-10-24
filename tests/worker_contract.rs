use sedna_browser_mcp::{WorkerClient, WorkerConfig};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

fn config() -> WorkerConfig {
    WorkerConfig {
        node: std::env::var_os("SEDNA_BROWSER_NODE").unwrap_or_else(|| "node".into()),
        worker_path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/mock-worker.mjs"),
        call_timeout: Duration::from_secs(5),
        cancellation_grace: Duration::from_secs(2),
        max_response_bytes: 1024 * 1024,
        isolate_browser_environment: false,
        browser_config: None,
    }
}

fn body(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().expect("text content"))
        .expect("JSON receipt")
}

#[tokio::test]
async fn cancellation_keeps_the_queue_until_the_original_receipt_arrives() {
    let worker = WorkerClient::new(config());
    worker
        .call("ready".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let first_worker = worker.clone();
    let first_cancel = cancel.clone();
    let first = tokio::spawn(async move {
        first_worker
            .call("delay".into(), json!({"milliseconds": 200}), first_cancel)
            .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    cancel.cancel();
    let second = worker
        .call("observe".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    let first = first.await.unwrap().unwrap();
    assert_eq!(
        body(&first),
        json!({"cancelled":true,"sequence":2,"concurrent_at_start":0})
    );
    assert_eq!(body(&second), json!({"active":0,"sequence":3,"echoed":{}}));
    worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_a_caller_cancels_but_does_not_release_the_browser_early() {
    let worker = WorkerClient::new(config());
    worker
        .call("ready".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    let first_worker = worker.clone();
    let first = tokio::spawn(async move {
        first_worker
            .call(
                "delay".into(),
                json!({"milliseconds": 200}),
                CancellationToken::new(),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    first.abort();
    let _ = first.await;
    let second = worker
        .call("observe".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(body(&second), json!({"active":0,"sequence":3,"echoed":{}}));
    worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_cancel_ack_after_the_original_receipt_does_not_corrupt_the_next_call() {
    let worker = WorkerClient::new(config());
    worker
        .call("ready".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let first_worker = worker.clone();
    let first_cancel = cancel.clone();
    let first = tokio::spawn(async move {
        first_worker
            .call(
                "late_cancel_ack".into(),
                json!({"milliseconds": 200}),
                first_cancel,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    cancel.cancel();
    let first = first.await.unwrap().unwrap();
    assert_eq!(body(&first)["cancelled"], true);
    let next = worker
        .call("observe".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(body(&next), json!({"active":0,"sequence":3,"echoed":{}}));
    worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_crashed_worker_is_not_restarted_or_replayed() {
    let worker = WorkerClient::new(config());
    assert!(
        worker
            .call("crash".into(), json!({}), CancellationToken::new())
            .await
            .is_err()
    );
    let next = worker
        .call("observe".into(), json!({}), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(next.contains("Start a new server explicitly"), "{next}");
    worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_oversized_worker_frame_retires_the_worker() {
    let mut settings = config();
    settings.max_response_bytes = 2048;
    let worker = WorkerClient::new(settings);
    let error = worker
        .call("oversize".into(), json!({}), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("output bound"), "{error}");
    let next = worker
        .call("observe".into(), json!({}), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(next.contains("unavailable"), "{next}");
    worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn full_admission_fails_before_the_running_operation_settles() {
    let worker = WorkerClient::new(config());
    worker
        .call("ready".into(), json!({}), CancellationToken::new())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let first_worker = worker.clone();
    let first_cancel = cancel.clone();
    let first = tokio::spawn(async move {
        first_worker
            .call("hold".into(), json!({}), first_cancel)
            .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;

    let mut calls = tokio::task::JoinSet::new();
    for _ in 0..64 {
        let caller = worker.clone();
        calls.spawn(async move {
            caller
                .call("observe".into(), json!({}), CancellationToken::new())
                .await
        });
    }
    let rejected = tokio::time::timeout(Duration::from_secs(1), calls.join_next())
        .await
        .expect("full admission must reject while the current operation is still held")
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(rejected.contains("queue is full"), "{rejected}");
    assert!(rejected.contains("nothing was dispatched"), "{rejected}");
    assert!(!first.is_finished());
    cancel.cancel();
    assert_eq!(body(&first.await.unwrap().unwrap())["cancelled"], true);
    while let Some(result) = calls.join_next().await {
        match result.unwrap() {
            Ok(result) => assert_eq!(body(&result)["active"], 0),
            Err(error) => assert!(error.contains("queue is full"), "{error}"),
        }
    }
    worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn oversized_arguments_are_rejected_without_starting_a_worker() {
    let mut settings = config();
    settings.node = "this-node-binary-does-not-exist".into();
    let worker = WorkerClient::new(settings);
    let error = worker
        .call(
            "observe".into(),
            json!({"text":"x".repeat(129 * 1024)}),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.contains("nothing was dispatched"), "{error}");
    worker.shutdown().await.unwrap();
}
