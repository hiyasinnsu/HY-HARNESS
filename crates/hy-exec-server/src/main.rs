mod checkpoint;
mod cmdline;
mod fs_guard;
mod job_object;
mod jobs;
mod patch;
mod ptc;
mod rpc;
mod sandbox;
mod server;
mod shell;

use std::sync::Arc;

use tokio::sync::watch;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .with_target(false)
        .init();

    let (peer, writer) = rpc::Peer::start();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let server = Arc::new(server::Server::new(peer.clone(), shutdown_tx));
    server.clone().run().await;
    server.shutdown().await;
    drop(server);
    drop(peer);
    let _ = writer.await;
    Ok(())
}
