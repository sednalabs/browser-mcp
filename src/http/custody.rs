//! Legacy HTTP transport custody only. Browser leases never use these IDs.
use super::auth::Principal;
use mcp_toolkit_http::session::BoundedSessionManager;
use mcp_toolkit_core::rmcp::transport::streamable_http_server::session::SessionManager;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

pub(super) struct LegacyCustody {
    owners: Mutex<HashMap<String, Principal>>,
    manager: Arc<BoundedSessionManager>,
    maximum: usize,
}
impl LegacyCustody {
    pub(super) fn new(manager: Arc<BoundedSessionManager>, maximum: usize) -> Self {
        Self { owners: Mutex::new(HashMap::new()), manager, maximum }
    }
    pub(super) async fn sweep(&self) {
        let ids: Vec<_> = self.owners.lock().await.keys().cloned().collect();
        for id in ids {
            if !self.manager.has_session(&id.as_str().into()).await.unwrap_or(false) {
                self.owners.lock().await.remove(&id);
            }
        }
    }
    pub(super) async fn check(&self, id: &str, owner: &Principal) -> bool {
        if self.owners.lock().await.get(id) != Some(owner) { return false; }
        self.manager.has_session(&id.into()).await.unwrap_or(false)
    }
    pub(super) async fn bind_issued(&self, id: &str, owner: Principal) -> bool {
        // Never adopt an arbitrary caller-supplied identifier. The transport
        // must first confirm this is one of its own live session identifiers.
        if !self.manager.has_session(&id.into()).await.unwrap_or(false) { return false; }
        self.sweep().await;
        let mut owners = self.owners.lock().await;
        if let Some(existing) = owners.get(id) { return existing == &owner; }
        if owners.len() >= self.maximum { return false; }
        owners.insert(id.into(), owner);
        true
    }
}
