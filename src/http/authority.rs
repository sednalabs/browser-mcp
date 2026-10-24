//! Application leases, independent of HTTP connections and legacy MCP sessions.
use crate::{WorkerClient, WorkerConfig};
use super::{auth::Principal, config::Limits};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::{Arc, Mutex, MutexGuard, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;

struct Slot {
    owner: Principal,
    name: String,
    worker: WorkerClient,
    created: Instant,
    used: Mutex<Instant>,
    active: AtomicUsize,
    closing: AtomicBool,
    cleanup_failed: AtomicBool,
}
struct Lease(Arc<Slot>);
impl Drop for Lease {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// All fields are private: only the authenticated HTTP layer issues principals.
pub struct BrowserAuthority {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    worker_config: WorkerConfig,
    limits: Limits,
    stopped: AtomicBool,
}
impl BrowserAuthority {
    pub(super) fn new(worker_config: WorkerConfig, limits: Limits) -> Arc<Self> {
        Arc::new(Self { slots: Mutex::new(HashMap::new()), worker_config, limits, stopped: AtomicBool::new(false) })
    }
    fn slots(&self) -> MutexGuard<'_, HashMap<String, Arc<Slot>>> {
        self.slots.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn valid_id(id: &str) -> bool {
        id.len() == 34 && id.starts_with("b_") && id[2..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }
    fn expired(&self, slot: &Slot) -> bool {
        slot.created.elapsed() >= Duration::from_secs(self.limits.lifetime_seconds)
            || (slot.active.load(Ordering::SeqCst) == 0
                && slot.used.lock().unwrap_or_else(|e| e.into_inner()).elapsed() >= Duration::from_secs(self.limits.idle_seconds))
    }
    fn unavailable() -> String { "Browser session unavailable. Create a new session explicitly; previous actions must not be replayed automatically.".into() }
    fn get_lease(&self, owner: &Principal, id: &str) -> Result<Lease, String> {
        if self.stopped.load(Ordering::SeqCst) { return Err("Browser service is shutting down.".into()); }
        let slots = self.slots();
        let slot = slots.get(id).filter(|slot| Self::valid_id(id) && &slot.owner == owner)
            .ok_or_else(Self::unavailable)?;
        if slot.closing.load(Ordering::SeqCst) || self.expired(slot) { return Err(Self::unavailable()); }
        slot.active.fetch_add(1, Ordering::SeqCst);
        Ok(Lease(slot.clone()))
    }
    fn create(&self, owner: &Principal, name: &str) -> Result<Value, String> {
        let mut slots = self.slots();
        if self.stopped.load(Ordering::SeqCst) { return Err("Browser service is shutting down.".into()); }
        if slots.len() >= self.limits.max_browsers || slots.values().filter(|slot| &slot.owner == owner).count() >= self.limits.max_browsers_per_owner {
            return Err("Browser capacity reached. Close an owned session or wait for its lease to expire; no browser was created.".into());
        }
        let id = format!("b_{}", uuid::Uuid::new_v4().simple());
        let slot = Arc::new(Slot { owner: owner.clone(), name: name.into(), worker: WorkerClient::new(self.worker_config.clone()),
            created: Instant::now(), used: Mutex::new(Instant::now()), active: AtomicUsize::new(0),
            closing: AtomicBool::new(false), cleanup_failed: AtomicBool::new(false) });
        let info = self.info(&id, &slot);
        slots.insert(id, slot);
        Ok(result(json!({"status":"created", "browser_session":info, "next":"Pass browser_session_id to browser_observe. Each create owns a different private browser."})))
    }
    fn info(&self, id: &str, slot: &Slot) -> Value {
        json!({"browser_session_id":id, "name":slot.name,
            "status":if slot.cleanup_failed.load(Ordering::SeqCst) {"cleanup_failed"} else if slot.closing.load(Ordering::SeqCst) {"closing"} else if self.expired(slot) {"expired"} else {"available"},
            "active_operations":slot.active.load(Ordering::SeqCst),
            "lifetime_seconds_remaining":self.limits.lifetime_seconds.saturating_sub(slot.created.elapsed().as_secs()),
            "idle_seconds":self.limits.idle_seconds})
    }
    pub(crate) async fn dispatch(self: &Arc<Self>, owner: &Principal, method: &str, mut params: Value, cancellation: CancellationToken) -> Result<Value, String> {
        let object = params.as_object().ok_or("Tool arguments must be an object.")?;
        if method == "browser_session" {
            match object.get("action").and_then(Value::as_str).unwrap_or("status") {
                "create" => {
                    exact_keys(object, &["action", "name"])?;
                    let name = match object.get("name") {
                        None => "browser",
                        Some(Value::String(name)) if !name.trim().is_empty() && name.len() <= 80 => name,
                        _ => return Err("name must be a nonempty string of at most 80 bytes.".into()),
                    };
                    if cancellation.is_cancelled() { return Err("Session creation cancelled before admission.".into()); }
                    return self.create(owner, name);
                }
                "list" => {
                    exact_keys(object, &["action"])?;
                    let entries: Vec<_> = self.slots().iter().filter(|(_, slot)| &slot.owner == owner).map(|(id, slot)| self.info(id, slot)).collect();
                    return Ok(result(json!({"browser_sessions":entries})));
                }
                "close" => {
                    exact_keys(object, &["action", "browser_session_id"])?;
                    let id = object.get("browser_session_id").and_then(Value::as_str).ok_or("browser_session_id is required over HTTP.")?.to_owned();
                    return self.close_owned(owner, &id).await;
                }
                "status" | "reset" => {}
                _ => return Err("Unknown browser_session action.".into()),
            }
        }
        let id = params.as_object_mut().ok_or("Arguments must be an object")?.remove("browser_session_id")
            .and_then(|v| v.as_str().map(str::to_owned)).ok_or("browser_session_id is required over HTTP. Call browser_session with action create first.")?;
        let lease = self.get_lease(owner, &id)?;
        let cancel = cancellation.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let method = method.to_owned();
        // The task owns the lease until the existing worker supervisor settles.
        // Dropping an HTTP response requests cancellation but cannot free this
        // slot while the original mouse/key operation is still completing.
        tokio::spawn(async move {
            let mut value = lease.0.worker.call(method, params, cancel).await?;
            if let Some(text) = value.pointer_mut("/content/0/text") {
                if let Some(raw) = text.as_str() {
                    if let Ok(mut data) = serde_json::from_str::<Value>(raw) {
                        if let Some(object) = data.as_object_mut() {
                            object.insert("browser_session_id".into(), json!(id));
                            *text = Value::String(data.to_string());
                        }
                    }
                }
            }
            drop(lease);
            Ok::<_, String>(value)
        }).await.map_err(|_| "Browser operation supervisor stopped. Its outcome may be uncertain.".to_string())?
    }
    async fn close_owned(self: &Arc<Self>, owner: &Principal, id: &str) -> Result<Value, String> {
        let slot = {
            let slots = self.slots();
            let slot = slots.get(id).filter(|slot| Self::valid_id(id) && &slot.owner == owner).ok_or_else(Self::unavailable)?;
            if slot.closing.swap(true, Ordering::SeqCst) { return Ok(result(self.info(id, slot))); }
            slot.clone()
        };
        let authority = self.clone();
        let id = id.to_string();
        // Cleanup continues if the client loses this response. Retiring workers
        // remain counted against quotas until cleanup has actually completed.
        tokio::spawn(async move {
            authority.retire(&id, slot).await?;
            Ok(result(json!({"browser_session_id":id,"status":"closed"})))
        }).await.map_err(|_| "Browser cleanup supervisor stopped.".to_string())?
    }
    async fn retire(&self, id: &str, slot: Arc<Slot>) -> Result<(), String> {
        if let Err(error) = slot.worker.shutdown().await {
            slot.cleanup_failed.store(true, Ordering::SeqCst);
            return Err(error);
        }
        let mut slots = self.slots();
        if slots.get(id).is_some_and(|current| Arc::ptr_eq(current, &slot)) { slots.remove(id); }
        Ok(())
    }
    pub(super) async fn sweep(self: &Arc<Self>) {
        let expired: Vec<_> = {
            let slots = self.slots();
            slots.iter().filter_map(|(id, slot)| {
                if slot.active.load(Ordering::SeqCst) == 0 && self.expired(slot) && !slot.closing.swap(true, Ordering::SeqCst) { Some((id.clone(), slot.clone())) } else { None }
            }).collect()
        };
        for (id, slot) in expired {
            let authority = self.clone();
            tokio::spawn(async move { if authority.retire(&id, slot).await.is_err() { eprintln!("Browser lease cleanup failed; slot quarantined against quota."); } });
        }
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.stopped.store(true, Ordering::SeqCst);
        let slots: Vec<_> = self.slots().iter().map(|(id, slot)| { slot.closing.store(true, Ordering::SeqCst); (id.clone(), slot.clone()) }).collect();
        let mut tasks = tokio::task::JoinSet::new();
        for (id, slot) in slots { tasks.spawn(async move { (id, slot.worker.shutdown().await) }); }
        let mut failed = false;
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((id, Ok(()))) => { self.slots().remove(&id); }
                _ => failed = true,
            }
        }
        if failed { Err("One or more browser workers did not confirm clean shutdown.".into()) } else { Ok(()) }
    }
}
fn exact_keys(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    if object.keys().any(|key| !keys.contains(&key.as_str())) { Err("Unexpected session-management argument.".into()) } else { Ok(()) }
}
fn result(data: Value) -> Value { json!({"content":[{"type":"text","text":data.to_string()}],"isError":false}) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn config() -> WorkerConfig {
        WorkerConfig {
            node: "node".into(), worker_path: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock-worker.mjs"),
            call_timeout: Duration::from_secs(5), cancellation_grace: Duration::from_secs(2),
            max_response_bytes: 1024 * 1024, isolate_browser_environment: true, browser_config: None,
        }
    }
    fn payload(value: &Value) -> Value { serde_json::from_str(value["content"][0]["text"].as_str().unwrap()).unwrap() }
    async fn create(authority: &Arc<BrowserAuthority>, owner: &Principal) -> String {
        let value = authority.dispatch(owner, "browser_session", json!({"action":"create"}), CancellationToken::new()).await.unwrap();
        payload(&value)["browser_session"]["browser_session_id"].as_str().unwrap().into()
    }
    #[tokio::test]
    async fn foreign_and_missing_browser_ids_have_the_same_failure() {
        let authority = BrowserAuthority::new(config(), Limits::default());
        let alice = Principal::test("alice"); let bob = Principal::test("bob");
        let id = create(&authority, &alice).await;
        let foreign = authority.dispatch(&bob, "observe", json!({"browser_session_id":id}), CancellationToken::new()).await.unwrap_err();
        let absent = authority.dispatch(&bob, "observe", json!({"browser_session_id":"b_00000000000000000000000000000000"}), CancellationToken::new()).await.unwrap_err();
        assert_eq!(foreign, absent);
        let listed = authority.dispatch(&bob, "browser_session", json!({"action":"list"}), CancellationToken::new()).await.unwrap();
        assert!(payload(&listed)["browser_sessions"].as_array().unwrap().is_empty());
        authority.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn same_owner_can_have_multiple_independent_workers() {
        let authority = BrowserAuthority::new(config(), Limits::default());
        let owner = Principal::test("alice");
        let first = create(&authority, &owner).await; let second = create(&authority, &owner).await;
        assert_ne!(first, second);
        for id in [first.clone(), second] {
            let value = authority.dispatch(&owner, "observe", json!({"browser_session_id":id}), CancellationToken::new()).await.unwrap();
            assert_eq!(payload(&value)["sequence"], 1);
        }
        let value = authority.dispatch(&owner, "observe", json!({"browser_session_id":first}), CancellationToken::new()).await.unwrap();
        assert_eq!(payload(&value)["sequence"], 2);
        authority.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn capacity_rejects_without_reusing_or_evicting_a_browser() {
        let authority = BrowserAuthority::new(config(), Limits { max_browsers: 1, max_browsers_per_owner: 1, ..Limits::default() });
        let owner = Principal::test("alice");
        let id = create(&authority, &owner).await;
        assert!(authority.dispatch(&owner, "browser_session", json!({"action":"create"}), CancellationToken::new()).await.is_err());
        authority.dispatch(&owner, "browser_session", json!({"action":"close","browser_session_id":id}), CancellationToken::new()).await.unwrap();
        let new_id = create(&authority, &owner).await;
        assert_ne!(new_id, id);
        authority.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn expired_browser_is_not_implicitly_recreated() {
        let authority = BrowserAuthority::new(config(), Limits { idle_seconds: 1, ..Limits::default() });
        let owner = Principal::test("alice"); let id = create(&authority, &owner).await;
        { let slots = authority.slots(); *slots[&id].used.lock().unwrap() = Instant::now() - Duration::from_secs(2); }
        assert!(authority.dispatch(&owner, "observe", json!({"browser_session_id":id}), CancellationToken::new()).await.is_err());
        authority.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn dropping_http_waiter_does_not_free_the_lease_before_settlement() {
        let authority = BrowserAuthority::new(config(), Limits::default());
        let owner = Principal::test("alice"); let id = create(&authority, &owner).await;
        // Start the mock so the admission assertion does not depend on process startup.
        authority.dispatch(&owner, "ready", json!({"browser_session_id":id}), CancellationToken::new()).await.unwrap();
        let operation_authority = authority.clone(); let operation_owner = owner.clone(); let operation_id = id.clone();
        let task = tokio::spawn(async move { operation_authority.dispatch(&operation_owner, "delay", json!({"browser_session_id":operation_id,"milliseconds":350}), CancellationToken::new()).await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        task.abort(); let _ = task.await;
        assert_eq!(authority.slots()[&id].active.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(authority.slots()[&id].active.load(Ordering::SeqCst), 0);
        authority.shutdown().await.unwrap();
    }
}
