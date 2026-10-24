//! Authentication is the shared toolkit's responsibility. This module consumes
//! its request-bound witness once and keeps only a non-secret owner identity.
use super::config::HttpConfig;
use mcp_toolkit_auth::{
    AuthConfig, AuthContext, AuthMode, AuthSecurityProfile, Authenticator, discover_oidc_metadata,
    surface::{
        AuthSurfaceConfig, AuthSurfaceLayer, AuthorizationServerMetadataSource, IssuerEntry,
    },
};
use std::sync::Arc;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub(crate) struct Principal {
    issuer: String,
    subject: String,
    client_id: Option<String>,
}
impl Principal {
    pub(super) fn from_authenticated(auth: &AuthContext, issuer: &str) -> Result<Self, String> {
        let subject = auth
            .subject
            .as_deref()
            .filter(|v| !v.is_empty() && v.len() <= 512)
            .ok_or("Authenticated subject is missing or invalid.")?;
        if auth
            .azp
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 512)
        {
            return Err("Invalid authorized client identity.".into());
        }
        Ok(Self {
            issuer: issuer.into(),
            subject: subject.into(),
            client_id: auth.azp.clone(),
        })
    }
    #[cfg(test)]
    pub(super) fn test(subject: &str) -> Self {
        Self {
            issuer: "https://issuer.invalid".into(),
            subject: subject.into(),
            client_id: Some("test".into()),
        }
    }
}
pub(super) struct Authentication {
    pub authenticator: Arc<Authenticator>,
    pub layer: AuthSurfaceLayer,
    pub issuer: String,
}
pub(super) async fn build(config: &HttpConfig) -> Result<Authentication, String> {
    let issuer = config.auth.issuer.trim_end_matches('/').to_string();
    let metadata = discover_oidc_metadata(&issuer, None).await.map_err(|_| "Authorization-server discovery failed; refusing to start without verified issuer metadata.")?;
    // Discovery validates all endpoint URLs. The local-development exception is
    // also checked here, rather than silently admitting HTTP in production.
    super::config::validate_endpoint(&metadata.jwks_uri, config.allow_loopback_http)?;
    for endpoint in [
        &metadata.authorization_endpoint,
        &metadata.token_endpoint,
        &metadata.registration_endpoint,
        &metadata.introspection_endpoint,
        &metadata.device_authorization_endpoint,
    ]
    .into_iter()
    .flatten()
    {
        super::config::validate_endpoint(endpoint, config.allow_loopback_http)?;
    }
    let mut settings = AuthConfig::with_profile(AuthSecurityProfile::L2Strong);
    settings.mode = AuthMode::Jwks;
    settings.issuer = Some(issuer.clone());
    settings.audience = Some(config.resource_url.clone());
    settings.jwks_url = Some(metadata.jwks_uri.clone());
    settings.required_scopes = config.auth.required_scopes.clone();
    settings.actor_claim = "sub".into();
    let authenticator = Arc::new(
        Authenticator::new(settings).map_err(|_| "Invalid authentication configuration.")?,
    );
    let entry = IssuerEntry::from_metadata_source(
        "/mcp",
        AuthorizationServerMetadataSource::OidcDiscovery(metadata),
        "sedna-browser",
        config.auth.required_scopes.clone(),
        config.auth.allowed_client_ids.clone(),
        authenticator.clone(),
        Some(config.resource_url.clone()),
    )
    .map_err(|_| "Invalid OAuth resource metadata.")?;
    let mut surface = AuthSurfaceConfig::single_issuer(config.public_base_url()?, entry);
    surface.allow_insecure_http = config.allow_loopback_http;
    surface.public_paths.insert("/healthz".into());
    let layer =
        AuthSurfaceLayer::from_config(surface).map_err(|_| "Invalid authentication surface.")?;
    Ok(Authentication {
        authenticator,
        layer,
        issuer,
    })
}
