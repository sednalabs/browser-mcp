use sedna_browser_mcp::{BrowserServer, WorkerClient, WorkerConfig, server::tool_definitions};
use std::{ffi::OsString, path::PathBuf};
use tokio_util::sync::CancellationToken;

const HELP: &str = "sedna-browser-mcp: persistent visual browser tools over stdio MCP\n\nUsage: sedna-browser-mcp [OPTIONS]\n\n  --transport MODE      stdio (default) or http (Streamable HTTP/HTTPS)\n  --http-config PATH    Operator configuration with issuer, TLS and browser quotas\n  --worker PATH         Operator-selected worker/main.mjs\n  --node PATH           Node executable (default: node)\n  --timeout SECONDS     Operation timeout before cooperative cancellation (default: 120)\n  --check               Launch Chromium, capture about:blank and report readiness\n  --print-tools         Print advertised tool names without starting the browser\n  --print-tool-schema   Print the shared MCP tool definitions\n  --version             Print version\n  --help                Print this help\n\nNo arguments starts MCP on stdin/stdout; diagnostics use stderr.\nThe server supports MCP 2026-07-28 and legacy 2025-11-25 via RMCP.\n";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("sedna-browser-mcp: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut worker = None::<PathBuf>;
    let mut node = None::<OsString>;
    let mut timeout = 120_u64;
    let mut mode = "serve";
    let mut transport = "stdio".to_string();
    let mut http_config = None::<PathBuf>;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        match argument.to_str() {
            Some("--help" | "-h") => {
                print!("{HELP}");
                return Ok(());
            }
            Some("--version" | "-V") => {
                println!("sedna-browser-mcp {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            Some("--worker") => {
                worker = Some(args.next().ok_or("--worker requires a path")?.into())
            }
            Some("--node") => node = Some(args.next().ok_or("--node requires an executable")?),
            Some("--timeout") => {
                timeout = args
                    .next()
                    .ok_or("--timeout requires seconds")?
                    .to_str()
                    .ok_or("--timeout must be an integer")?
                    .parse()
                    .map_err(|_| "--timeout must be an integer")?
            }
            Some("--transport") => {
                transport = args
                    .next()
                    .ok_or("--transport requires stdio or http")?
                    .into_string()
                    .map_err(|_| "Invalid transport")?;
                if !["stdio", "http"].contains(&transport.as_str()) {
                    return Err("--transport requires stdio or http".into());
                }
            }
            Some("--http-config") => {
                http_config = Some(args.next().ok_or("--http-config requires a file")?.into())
            }
            Some("--check") => mode = "check",
            Some("--print-tools") => mode = "tools",
            Some("--print-tool-schema") => mode = "schema",
            _ => {
                return Err(format!(
                    "unknown argument: {}\n{HELP}",
                    argument.to_string_lossy()
                ));
            }
        }
    }
    if mode == "tools" || mode == "schema" {
        let tools = if transport == "http" {
            #[cfg(feature = "http")]
            {
                sedna_browser_mcp::http::tool_definitions()?
            }
            #[cfg(not(feature = "http"))]
            {
                return Err("Build with the http feature to advertise HTTP tools.".into());
            }
        } else {
            tool_definitions()?
        };
        if mode == "tools" {
            for tool in tools {
                println!("{}", tool.name);
            }
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&tools).map_err(|error| error.to_string())?
            );
        }
        return Ok(());
    }
    let worker_config = WorkerConfig::resolve(worker, node, timeout)?;
    if transport == "http" {
        if mode != "serve" {
            return Err("--check is stdio-only; use /healthz and an authenticated browser_observe for HTTP readiness.".into());
        }
        #[cfg(feature = "http")]
        {
            let path = http_config.ok_or(
                "--http-config is required for HTTP; unauthenticated HTTP is not supported.",
            )?;
            let config = sedna_browser_mcp::http::config::HttpConfig::load(&path)?;
            let stop = CancellationToken::new();
            let signal_stop = stop.clone();
            let signal = tokio::spawn(async move {
                shutdown_signal().await;
                signal_stop.cancel();
            });
            let result = sedna_browser_mcp::http::serve(worker_config, config, stop).await;
            signal.abort();
            return result;
        }
        #[cfg(not(feature = "http"))]
        {
            return Err("This binary was built without the http feature.".into());
        }
    }
    if http_config.is_some() {
        return Err("--http-config requires --transport http.".into());
    }
    let client = WorkerClient::new(worker_config);
    let outcome = if mode == "check" {
        match client
            .call(
                "check".into(),
                serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
        {
            Ok(result) => {
                if let Some(content) = result.get("content").and_then(serde_json::Value::as_array) {
                    for block in content {
                        if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                            println!("{text}");
                        }
                    }
                }
                if result.get("isError").and_then(serde_json::Value::as_bool) == Some(true) {
                    Err("browser readiness check failed".into())
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(error),
        }
    } else {
        let server = BrowserServer::new(client.clone())?;
        tokio::select! {
            result = mcp_toolkit_server::stdio::StdioServerBuilder::new().serve(server) =>
                result.map(|_| ()).map_err(|error| error.to_string()),
            _ = shutdown_signal() => Ok(()),
        }
    };
    let cleanup = client.shutdown().await;
    outcome.and(cleanup)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
