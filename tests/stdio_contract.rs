use mcp_toolkit_testing::stdio_contract::StdioMcpProcess;
use serde_json::json;

const BINARY: &str = env!("CARGO_BIN_EXE_sedna-browser-mcp");
const TOOLS: &[&str] = &[
    "browser_observe",
    "browser_step",
    "browser_review",
    "browser_inspect",
    "browser_tabs",
    "browser_session",
];

#[test]
fn modern_client_lists_tools_without_initialize() {
    let mut server = StdioMcpProcess::start(BINARY);
    let mut expected: Vec<_> = TOOLS.iter().map(|value| value.to_string()).collect();
    expected.sort();
    let mut actual = server.list_tool_names();
    actual.sort();
    assert_eq!(actual, expected);
}

#[test]
fn legacy_client_can_still_negotiate_and_list_tools() {
    let mut server =
        StdioMcpProcess::start_legacy_with_client(BINARY, "browser-legacy-test", "2025-11-25");
    let mut expected: Vec<_> = TOOLS.iter().map(|value| value.to_string()).collect();
    expected.sort();
    let mut actual = server.list_tool_names();
    actual.sort();
    assert_eq!(actual, expected);
}

#[test]
fn unknown_tools_are_rejected_at_the_host_without_dispatch() {
    let mut server = StdioMcpProcess::start(BINARY);
    let response = server.call_tool(7, "browser_does_not_exist", json!({}));
    assert!(response.get("error").is_some(), "{response}");
}

#[test]
fn modern_catalog_has_explicit_private_zero_lifetime_cache_hints() {
    let mut server = StdioMcpProcess::start(BINARY);
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 9,
        "method": "tools/list",
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {"name": "browser-cache-contract", "version": "0.1.0"},
                "io.modelcontextprotocol/clientCapabilities": {}
            }
        }
    }));
    let response = server.response(9);
    assert_eq!(response["result"]["ttlMs"], 0);
    assert_eq!(response["result"]["cacheScope"], "private");
    assert_eq!(response["result"]["resultType"], "complete");
}
