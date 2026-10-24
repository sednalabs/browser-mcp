//! Operator-only HTTP configuration. Never deserialize this from a tool call.
use serde::Deserialize;
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};
use url::Url;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpConfig {
    pub bind: SocketAddr,
    /// Canonical externally visible URL, ending in /mcp.
    pub resource_url: String,
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    pub auth: AuthSettings,
    pub tls: Option<TlsSettings>,
    /// Explicit local development; does not permit insecure non-loopback URLs.
    #[serde(default)]
    pub allow_loopback_http: bool,
    pub browser_config: Option<PathBuf>,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TlsSettings {
    pub certificate: PathBuf,
    pub private_key: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthSettings {
    pub issuer: String,
    #[serde(default)]
    pub allowed_client_ids: HashSet<String>,
    /// Empty lists are refused; defaults to browser:use.
    #[serde(default = "default_scopes")]
    pub required_scopes: Vec<String>,
}
fn default_scopes() -> Vec<String> {
    vec!["browser:use".into()]
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub max_browsers: usize,
    pub max_browsers_per_owner: usize,
    pub idle_seconds: u64,
    pub lifetime_seconds: u64,
    pub max_http_requests: usize,
    pub max_legacy_sessions: usize,
    pub max_request_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_browsers: 16,
            max_browsers_per_owner: 4,
            idle_seconds: 1800,
            lifetime_seconds: 86400,
            max_http_requests: 32,
            max_legacy_sessions: 64,
            max_request_bytes: 128 * 1024,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=128).contains(&self.max_browsers)
            || self.max_browsers_per_owner == 0
            || self.max_browsers_per_owner > self.max_browsers
            || !(1..=256).contains(&self.max_http_requests)
            || !(1..=1024).contains(&self.max_legacy_sessions)
            || !(1..=86400).contains(&self.idle_seconds)
            || self.lifetime_seconds < self.idle_seconds
            || self.lifetime_seconds > 604800
            || !(1024..=128 * 1024).contains(&self.max_request_bytes)
        {
            return Err("Invalid HTTP/browser limits; consult docs/http.md.".into());
        }
        Ok(())
    }
}

pub fn read_operator_file(path: &Path, maximum: u64, secret: bool) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect operator file: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        return Err("Operator file must be a bounded regular file, not a symlink.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let forbidden = if secret { 0o077 } else { 0o022 };
        if metadata.permissions().mode() & forbidden != 0 {
            return Err(
                "Operator file permissions are too broad; use 0600 for secrets and configuration."
                    .into(),
            );
        }
    }
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot read operator file: {e}"))?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read operator file: {e}"))?;
    if bytes.len() as u64 > maximum {
        return Err("Operator file grew beyond the configured bound.".into());
    }
    Ok(bytes)
}

fn is_loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}
pub fn validate_endpoint(raw: &str, allow_local: bool) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid endpoint URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Endpoint URLs must not contain credentials or fragments.".into());
    }
    if url.scheme() != "https" && !(allow_local && url.scheme() == "http" && is_loopback(&url)) {
        return Err(
            "Endpoints require HTTPS; explicit loopback HTTP is the sole development exception."
                .into(),
        );
    }
    Ok(url)
}
impl HttpConfig {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = read_operator_file(path, 65536, false)?;
        let mut value: Self = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid HTTP configuration: {e}"))?;
        let base = path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Configuration has no parent")?
            .to_path_buf();
        let absolute = |p: &mut PathBuf| {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        };
        if let Some(browser) = &mut value.browser_config {
            absolute(browser);
        }
        if let Some(tls) = &mut value.tls {
            absolute(&mut tls.certificate);
            absolute(&mut tls.private_key);
        }
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), String> {
        self.limits.validate()?;
        let resource = validate_endpoint(&self.resource_url, self.allow_loopback_http)?;
        if resource.path() != "/mcp" || resource.query().is_some() {
            return Err(
                "resource_url must identify the exact /mcp endpoint, with no query.".into(),
            );
        }
        let issuer = validate_endpoint(&self.auth.issuer, self.allow_loopback_http)?;
        if issuer.query().is_some() {
            return Err("issuer must not have a query.".into());
        }
        if !self.bind.ip().is_loopback() && self.tls.is_none() {
            return Err("Non-loopback listeners require native TLS. A reverse proxy must reach a loopback listener.".into());
        }
        if self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 32
            || self
                .allowed_hosts
                .iter()
                .any(|h| h.is_empty() || h.contains('*') || h.contains('/'))
        {
            return Err("Set 1..32 explicit allowed_hosts without wildcards.".into());
        }
        if self.allowed_origins.len() > 32 {
            return Err("Too many allowed_origins.".into());
        }
        for raw in &self.allowed_origins {
            let origin = validate_endpoint(raw, self.allow_loopback_http)?;
            if origin.origin().ascii_serialization() != *raw {
                return Err("allowed_origins must contain exact origins, without paths.".into());
            }
        }
        if self.auth.required_scopes.is_empty()
            || self.auth.required_scopes.len() > 32
            || self
                .auth
                .required_scopes
                .iter()
                .any(|s| s.is_empty() || s.len() > 128 || s.chars().any(char::is_whitespace))
        {
            return Err("Set at least one bounded authorization scope.".into());
        }
        if self.auth.allowed_client_ids.len() > 64
            || self
                .auth
                .allowed_client_ids
                .iter()
                .any(|s| s.is_empty() || s.len() > 256)
        {
            return Err("Invalid allowed_client_ids.".into());
        }
        if let Some(tls) = &self.tls {
            read_operator_file(&tls.certificate, 1024 * 1024, false)?;
            read_operator_file(&tls.private_key, 65536, true)?;
        }
        if let Some(path) = &self.browser_config {
            let value: serde_json::Value =
                serde_json::from_slice(&read_operator_file(path, 65536, true)?)
                    .map_err(|_| "Invalid browser template JSON")?;
            if !value.is_object() || value.get("profile").is_some() {
                return Err("HTTP browser templates must be objects without profile: every lease owns a fresh private profile.".into());
            }
        }
        Ok(())
    }
    pub fn public_base_url(&self) -> Result<String, String> {
        let mut value = validate_endpoint(&self.resource_url, self.allow_loopback_http)?;
        value.set_path("");
        Ok(value.as_str().trim_end_matches('/').into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn insecure_endpoints_are_only_explicit_loopback() {
        assert!(validate_endpoint("http://127.0.0.1:1234", true).is_ok());
        assert!(validate_endpoint("http://example.com", true).is_err());
        assert!(validate_endpoint("http://127.0.0.1:1234", false).is_err());
        assert!(validate_endpoint("https://user:secret@example.com", false).is_err());
    }
    #[test]
    fn quotas_are_finite_and_consistent() {
        assert!(Limits::default().validate().is_ok());
        assert!(
            Limits {
                max_browsers_per_owner: 100,
                ..Limits::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Limits {
                idle_seconds: 0,
                ..Limits::default()
            }
            .validate()
            .is_err()
        );
    }
}
