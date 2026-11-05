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
mod ws;

use std::io::Write as _;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

/// Command-line options. Without `--listen` the server speaks JSON-RPC lines
/// on stdio (the harness spawns it). CP-28: `--listen ws://IP:PORT` serves one
/// authenticated WebSocket client instead, so the daemon can run elsewhere.
struct Options {
    listen: Option<String>,
    token: Option<String>,
    allow_remote: bool,
}

fn parse_options() -> anyhow::Result<Options> {
    let mut options = Options {
        listen: None,
        token: std::env::var("HY_EXEC_TOKEN")
            .ok()
            .filter(|t| !t.is_empty()),
        allow_remote: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => {
                options.listen = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--listen needs ws://IP:PORT"))?,
                )
            }
            "--token" => {
                options.token = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--token needs a value"))?,
                )
            }
            "--allow-remote" => options.allow_remote = true,
            other => anyhow::bail!(
                "unknown option {other}; usage: hy-exec-server [--listen ws://IP:PORT --token T [--allow-remote]]"
            ),
        }
    }
    Ok(options)
}

/// `ws://127.0.0.1:8765` → the socket address; only loopback without `--allow-remote`.
fn listen_address(url: &str, allow_remote: bool) -> anyhow::Result<SocketAddr> {
    let rest = url
        .strip_prefix("ws://")
        .ok_or_else(|| anyhow::anyhow!("--listen must be ws://IP:PORT"))?;
    let addr: SocketAddr = rest
        .trim_end_matches('/')
        .parse()
        .map_err(|e| anyhow::anyhow!("--listen {url}: {e}"))?;
    if !addr.ip().is_loopback() && !allow_remote {
        anyhow::bail!(
            "refusing to listen on {}: pass --allow-remote to accept other machines",
            addr.ip()
        );
    }
    Ok(addr)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .with_target(false)
        .init();

    let options = parse_options()?;
    let (in_tx, in_rx) = mpsc::unbounded_channel::<std::io::Result<String>>();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();

    let transport = match &options.listen {
        None => tokio::spawn(stdio(in_tx, out_rx)),
        Some(url) => {
            let addr = listen_address(url, options.allow_remote)?;
            let token = options.token.clone().ok_or_else(|| {
                anyhow::anyhow!("--listen needs a token (--token or HY_EXEC_TOKEN)")
            })?;
            let listener = TcpListener::bind(addr).await?;
            let bound = listener.local_addr()?;
            // The one line on stdout in this mode: where to connect (port 0 picks one).
            let mut out = std::io::stdout();
            writeln!(
                out,
                "{}",
                serde_json::json!({ "listening": format!("ws://{bound}") })
            )?;
            out.flush()?;
            tracing::info!(%bound, "listening for one WebSocket client");
            tokio::spawn(websocket(listener, token, in_tx, out_rx))
        }
    };

    let (peer, writer) = rpc::Peer::start(out_tx);
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let server = Arc::new(server::Server::new(peer.clone(), shutdown_tx));
    server.clone().run(in_rx).await;
    server.shutdown().await;
    drop(server);
    drop(peer);
    let _ = writer.await;
    transport.abort();
    Ok(())
}

/// Newline-delimited JSON on stdin/stdout.
async fn stdio(
    in_tx: mpsc::UnboundedSender<std::io::Result<String>>,
    mut out_rx: mpsc::UnboundedReceiver<String>,
) {
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if in_tx.send(Ok(line)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = in_tx.send(Err(e));
                    break;
                }
            }
        }
    });
    let mut out = tokio::io::stdout();
    while let Some(text) = out_rx.recv().await {
        if out.write_all(text.as_bytes()).await.is_err()
            || out.write_all(b"\n").await.is_err()
            || out.flush().await.is_err()
        {
            break;
        }
    }
    reader.abort();
}

/// Accepts connections until one presents the token, then serves it. When
/// that client goes away the inbound channel closes and the server exits,
/// like stdio at EOF. Bad handshakes are answered and the next is accepted.
async fn websocket(
    listener: TcpListener,
    token: String,
    in_tx: mpsc::UnboundedSender<std::io::Result<String>>,
    mut out_rx: mpsc::UnboundedReceiver<String>,
) {
    let stream = loop {
        let Ok((mut stream, peer)) = listener.accept().await else {
            continue;
        };
        let head = match ws::read_head(&mut stream).await {
            Ok(h) => h,
            Err(_) => continue,
        };
        let Some(up) = ws::parse_upgrade(&head) else {
            let _ = stream
                .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        };
        let is_ws = up
            .upgrade
            .as_deref()
            .is_some_and(|u| u.eq_ignore_ascii_case("websocket"))
            && up.version.as_deref() == Some("13");
        let Some(key) = up.key.clone().filter(|_| is_ws) else {
            let _ = stream
                .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        };
        if !up.token().is_some_and(|t| ws::same_token(&t, &token)) {
            tracing::warn!(%peer, "rejected a WebSocket client without the token");
            let _ = stream
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            ws::accept_key(&key)
        );
        if stream.write_all(response.as_bytes()).await.is_err() {
            continue;
        }
        tracing::info!(%peer, "WebSocket client connected");
        break stream;
    };
    let (mut read_half, mut write_half) = stream.into_split();
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let pong_tx = frame_tx.clone();
    let reader = tokio::spawn(async move {
        loop {
            match ws::read_message(&mut read_half).await {
                Ok(ws::Incoming::Text(text)) => {
                    if in_tx.send(Ok(text)).is_err() {
                        break;
                    }
                }
                Ok(ws::Incoming::Ping(payload)) => {
                    let _ = pong_tx.send(ws::encode_frame(0xa, &payload));
                }
                Ok(ws::Incoming::Close) | Err(_) => break,
            }
        }
        // Dropping in_tx ends Server::run.
    });
    let forward = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if frame_tx
                .send(ws::encode_frame(0x1, text.as_bytes()))
                .is_err()
            {
                break;
            }
        }
    });
    while let Some(frame) = frame_rx.recv().await {
        if write_half.write_all(&frame).await.is_err() {
            break;
        }
    }
    reader.abort();
    forward.abort();
}
