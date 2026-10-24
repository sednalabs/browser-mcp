//! A thin MCP host for one privately owned, persistent Playwright worker.
//!
//! RMCP owns protocol negotiation and transport. The worker owns browser state,
//! execution, observations and action receipts. An actor retains each dispatched
//! request until completion, including after its MCP caller is cancelled.

pub mod config;
mod process;
pub mod server;
pub mod worker;

pub use config::WorkerConfig;
pub use server::BrowserServer;
pub use worker::WorkerClient;

#[cfg(feature = "http")]
pub mod http;
