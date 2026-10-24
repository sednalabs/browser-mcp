//! Streamable HTTP is an adapter over the same browser worker, not a second
//! browser implementation. TLS and inbound auth never reach the worker.
mod auth;
mod authority;
pub mod config;
mod custody;

use crate::{BrowserServer, WorkerConfig};
use ::http::{
    Method, StatusCode,
    header::{AUTHORIZATION, CACHE_CONTROL, HeaderValue},
};
use auth::{Authentication, Principal};
pub use authority::BrowserAuthority;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    middleware::{self, Next},
    response::Response,
};
use config::HttpConfig;
use custody::LegacyCustody;
use mcp_toolkit_auth::{
    AuthContext, Authenticator, VerifiedAuthContext,
    consume_verified_auth_surface_request_from_request,
};
use mcp_toolkit_core::rmcp::model::Tool;
use mcp_toolkit_server::http::{
    HttpBindSafety, LocalMcpHttpRouterBuilder, LocalMcpHttpRuntimeBuilder,
};
use serde_json::{Value, json};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

/// Created only after consuming the toolkit's live authentication witness.
/// No raw bearer token or complete claims object is retained here.
#[derive(Clone)]
pub(crate) struct RequestPrincipal(Principal);
impl RequestPrincipal {
    pub(crate) fn owner(&self) -> &Principal {
        &self.0
    }
}

#[derive(Clone)]
struct GuardState {
    authenticator: Arc<Authenticator>,
    issuer: String,
    custody: Arc<LegacyCustody>,
    request_bytes: usize,
    allowed_clients: std::collections::HashSet<String>,
}

/// HTTP adds explicit application lease routing. The six tool names and the
/// worker schemas remain shared; browser_session gains only create/list.
pub fn tool_definitions() -> Result<Vec<Tool>, String> {
    let mut catalog: Value =
        serde_json::from_str(include_str!("../../worker/tools.json")).map_err(|e| e.to_string())?;
    for tool in catalog.as_array_mut().ok_or("Invalid browser catalog")? {
        let name = tool["name"].as_str().ok_or("Missing tool name")?.to_owned();
        let schema = &mut tool["inputSchema"];
        if name == "browser_session" {
            *schema = json!({"type":"object", "additionalProperties":false,
                "properties":{
                    "action":{"enum":["create","list","status","reset","close"]},
                    "name":{"type":"string","minLength":1,"maxLength":80},
                    "browser_session_id":{"type":"string","pattern":"^b_[0-9a-f]{32}$"}},
                "required":["action"],
                "allOf":[{"if":{"properties":{"action":{"enum":["status","reset","close"]}}},"then":{"required":["browser_session_id"]}}]});
            tool["description"] = json!(
                "Manage your authenticated browser leases. Create allocates a private live browser lazily and returns browser_session_id; list shows only your leases. Pass that ID on every later tool call. Status reconciles last_operation after a lost/cancelled response. Reset discards transient browser state; close terminates the worker and releases its profile. Neither HTTP reconnect nor OAuth token refresh changes browser identity. Leases are bounded and do not survive service restart."
            );
        } else {
            schema["properties"]
                .as_object_mut()
                .ok_or("Invalid schema properties")?
                .insert(
                    "browser_session_id".into(),
                    json!({"type":"string","pattern":"^b_[0-9a-f]{32}$"}),
                );
            let object = schema.as_object_mut().ok_or("Invalid schema")?;
            object
                .entry("required")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Invalid required list")?
                .push(json!("browser_session_id"));
        }
    }
    serde_json::from_value(catalog).map_err(|e| e.to_string())
}

/// Starts native TLS when configured; otherwise binds a loopback-only listener
/// suitable for a local client or a trusted HTTPS reverse proxy.
pub async fn serve(
    mut worker: WorkerConfig,
    config: HttpConfig,
    stop: CancellationToken,
) -> Result<(), String> {
    config.validate()?;
    HttpBindSafety::new(!config.bind.ip().is_loopback(), true)
        .validate(config.bind)
        .map_err(|e| e.to_string())?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let authentication = auth::build(&config).await?;
    worker.isolate_browser_environment = true;
    worker.browser_config = config.browser_config.clone();
    let authority = BrowserAuthority::new(worker, config.limits.clone());
    let (router, custody) = build_router(&config, authority.clone(), authentication, stop.clone())?;
    let sweep_stop = stop.clone();
    let sweep_authority = authority.clone();
    let sweep = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = sweep_stop.cancelled() => break,
                _ = tick.tick() => { sweep_authority.sweep().await; custody.sweep().await; }
            }
        }
    });
    let handle = axum_server::Handle::new();
    let shutdown_handle = handle.clone();
    let shutdown_stop = stop.clone();
    let shutdown = tokio::spawn(async move {
        shutdown_stop.cancelled().await;
        shutdown_handle.graceful_shutdown(Some(Duration::from_secs(80)));
    });
    eprintln!(
        "sedna-browser-mcp: authenticated {} listener on {}",
        if config.tls.is_some() {
            "HTTPS"
        } else {
            "loopback HTTP"
        },
        config.bind
    );
    let outcome = if let Some(tls) = &config.tls {
        match axum_server::tls_rustls::RustlsConfig::from_pem_file(
            &tls.certificate,
            &tls.private_key,
        )
        .await
        {
            Ok(tls) => axum_server::bind_rustls(config.bind, tls)
                .handle(handle)
                .serve(router.into_make_service())
                .await
                .map_err(|e| format!("HTTPS server failed: {e}")),
            Err(_) => Err("Cannot load TLS certificate/private key.".into()),
        }
    } else {
        axum_server::bind(config.bind)
            .handle(handle)
            .serve(router.into_make_service())
            .await
            .map_err(|e| format!("HTTP server failed: {e}"))
    };
    stop.cancel();
    let _ = sweep.await;
    shutdown.abort();
    let cleanup = authority.shutdown().await;
    outcome.and(cleanup)
}

fn build_router(
    config: &HttpConfig,
    authority: Arc<BrowserAuthority>,
    authentication: Authentication,
    stop: CancellationToken,
) -> Result<(Router, Arc<LegacyCustody>), String> {
    let server = BrowserServer::new_http(authority)?;
    let runtime = LocalMcpHttpRuntimeBuilder::new()
        .allowed_hosts(config.allowed_hosts.clone())
        .allowed_origins(config.allowed_origins.clone())
        .max_sessions(config.limits.max_legacy_sessions)
        .max_request_body_bytes(config.limits.max_request_bytes)
        .allow_resume(false)
        .stateless_fallback(false)
        .cancellation_token(stop)
        .build(move || Ok::<_, std::io::Error>(server.clone()));
    let custody = Arc::new(LegacyCustody::new(
        runtime.session_manager.clone(),
        config.limits.max_legacy_sessions,
    ));
    let guards = GuardState {
        authenticator: authentication.authenticator,
        issuer: authentication.issuer,
        custody: custody.clone(),
        request_bytes: config.limits.max_request_bytes,
        allowed_clients: config.auth.allowed_client_ids.clone(),
    };
    // Tower layers run outside-in: budget -> shared auth -> request identity ->
    // toolkit Host/Origin/protocol router. The private identity is captured
    // before RMCP starts a task or returns an SSE response body.
    let router = LocalMcpHttpRouterBuilder::new(runtime.into_state(true))
        .include_health(false)
        .build()
        .route(
            "/healthz",
            axum::routing::get(|| async { StatusCode::NO_CONTENT }),
        )
        .layer(middleware::from_fn_with_state(guards, bind_principal))
        .layer(authentication.layer)
        .layer(middleware::from_fn_with_state(
            Arc::new(Semaphore::new(config.limits.max_http_requests)),
            budget,
        ));
    Ok((router, custody))
}

fn rejection(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json!({"error":message}).to_string()))
        .expect("fixed HTTP response")
}
fn session_header(headers: &::http::HeaderMap) -> Result<Option<String>, ()> {
    let mut values = headers.get_all("mcp-session-id").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    let value = value.to_str().map_err(|_| ())?;
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(());
    }
    Ok(Some(value.into()))
}
fn declares_modern(headers: &::http::HeaderMap, payload: Option<&Value>) -> bool {
    // Only an exact supported-era hint is used for custody routing; RMCP still
    // validates the body, mirrored headers and protocol. Initialize is always
    // legacy and never bypasses its owner binding, whatever metadata it carries.
    if payload.is_some_and(|p| p.get("method").and_then(Value::as_str) == Some("initialize")) {
        return false;
    }
    headers
        .get("mcp-protocol-version")
        .and_then(|v| v.to_str().ok())
        == Some("2026-07-28")
        || payload
            .and_then(|p| p.pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion"))
            .and_then(Value::as_str)
            == Some("2026-07-28")
}
async fn bind_principal(State(state): State<GuardState>, request: Request, next: Next) -> Response {
    if request.uri().path() == "/healthz" {
        return next.run(request).await;
    }
    let witness =
        match consume_verified_auth_surface_request_from_request(&request, &state.authenticator) {
            Some(value) => value,
            None => {
                return rejection(
                    StatusCode::UNAUTHORIZED,
                    "Verified request authentication required.",
                );
            }
        };
    let auth = match witness.auth() {
        Some(auth) => auth,
        None => return rejection(StatusCode::UNAUTHORIZED, "Authentication required."),
    };
    if !state.allowed_clients.is_empty()
        && !auth
            .azp
            .as_ref()
            .is_some_and(|id| state.allowed_clients.contains(id))
    {
        return rejection(
            StatusCode::FORBIDDEN,
            "Client is not authorized for this resource.",
        );
    }
    let principal = match Principal::from_authenticated(auth, &state.issuer) {
        Ok(principal) => principal,
        Err(_) => {
            return rejection(
                StatusCode::FORBIDDEN,
                "Stable authenticated subject required.",
            );
        }
    };
    drop(witness);
    let (mut parts, body) = request.into_parts();
    let is_post = parts.method == Method::POST;
    let (body, modern) = if is_post {
        let bytes = match to_bytes(body, state.request_bytes).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return rejection(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Request body unavailable or above the configured limit.",
                );
            }
        };
        let payload = serde_json::from_slice::<Value>(&bytes).ok();
        let modern = declares_modern(&parts.headers, payload.as_ref());
        (Body::from(bytes), modern)
    } else {
        (body, declares_modern(&parts.headers, None))
    };
    if !modern {
        match session_header(&parts.headers) {
            Ok(Some(id)) if state.custody.check(&id, &principal).await => {}
            Ok(None) => {}
            _ => return rejection(StatusCode::NOT_FOUND, "Legacy session unavailable."),
        }
    }
    // Captured identity is non-secret and request-local. Do not retain inbound
    // credentials inside the SDK's longer-lived service/connection objects.
    parts.headers.remove(AUTHORIZATION);
    parts.headers.remove("proxy-authorization");
    parts.extensions.remove::<AuthContext>();
    parts.extensions.remove::<VerifiedAuthContext>();
    parts.extensions.insert(RequestPrincipal(principal.clone()));
    let response = next.run(Request::from_parts(parts, body)).await;
    if let Ok(Some(id)) = session_header(response.headers())
        && !state.custody.bind_issued(&id, principal).await
    {
        return rejection(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not bind the issued legacy session.",
        );
    }
    response
}

async fn budget(State(budget): State<Arc<Semaphore>>, request: Request, next: Next) -> Response {
    let permit = match budget.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let mut response = rejection(StatusCode::TOO_MANY_REQUESTS, "HTTP capacity reached.");
            response
                .headers_mut()
                .insert("retry-after", HeaderValue::from_static("1"));
            return response;
        }
    };
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(BudgetBody {
            inner: body,
            permit: Some(permit),
        }),
    )
}
struct BudgetBody {
    inner: Body,
    permit: Option<OwnedSemaphorePermit>,
}
impl http_body::Body for BudgetBody {
    type Data = bytes::Bytes;
    type Error = axum::Error;
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_frame(cx);
        if matches!(&result, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            this.permit.take();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        http_body::Body::is_end_stream(&self.inner)
    }
    fn size_hint(&self) -> http_body::SizeHint {
        http_body::Body::size_hint(&self.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initialization_never_uses_current_metadata_to_escape_custody() {
        let mut headers = ::http::HeaderMap::new();
        headers.insert(
            "mcp-protocol-version",
            HeaderValue::from_static("2026-07-28"),
        );
        assert!(!declares_modern(
            &headers,
            Some(&json!({"method":"initialize"}))
        ));
        assert!(declares_modern(
            &headers,
            Some(&json!({"method":"tools/list"}))
        ));
    }
    #[test]
    fn malformed_transport_ids_fail_closed() {
        let mut headers = ::http::HeaderMap::new();
        headers.append("mcp-session-id", HeaderValue::from_static("one"));
        headers.append("mcp-session-id", HeaderValue::from_static("two"));
        assert!(session_header(&headers).is_err());
    }
    #[test]
    fn http_catalog_requires_application_sessions_without_changing_tool_names() {
        let catalog = tool_definitions().unwrap();
        assert_eq!(catalog.len(), 6);
        for tool in catalog {
            let value = serde_json::to_value(tool).unwrap();
            if value["name"] != "browser_session" {
                assert!(
                    value["inputSchema"]["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("browser_session_id"))
                );
            }
        }
    }
    #[tokio::test]
    async fn streaming_budget_is_retained_until_body_is_dropped() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.clone().try_acquire_owned().unwrap();
        let body = BudgetBody {
            inner: Body::from("data: result\n\n"),
            permit: Some(permit),
        };
        assert_eq!(semaphore.available_permits(), 0);
        drop(body);
        assert_eq!(semaphore.available_permits(), 1);
    }
}
