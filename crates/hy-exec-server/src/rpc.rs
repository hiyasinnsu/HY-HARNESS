//! Newline-delimited JSON-RPC 2.0 over stdio, both directions (design §3).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use hy_protocol::{RequestId, RpcError, RpcMessage};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};

type Pending = Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>;

/// Sends messages to the client and tracks server-initiated requests.
#[derive(Clone)]
pub struct Peer {
    tx: mpsc::UnboundedSender<RpcMessage>,
    pending: Arc<Pending>,
    next: Arc<AtomicU64>,
}

impl Peer {
    /// Spawns the stdout writer task.
    pub fn start() -> (Self, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<RpcMessage>();
        let writer = tokio::spawn(async move {
            let mut out = tokio::io::stdout();
            while let Some(msg) = rx.recv().await {
                let Ok(mut line) = serde_json::to_vec(&msg) else {
                    continue;
                };
                line.push(b'\n');
                if out.write_all(&line).await.is_err() || out.flush().await.is_err() {
                    break;
                }
            }
        });
        (
            Self {
                tx,
                pending: Arc::new(Mutex::new(HashMap::new())),
                next: Arc::new(AtomicU64::new(1)),
            },
            writer,
        )
    }

    pub fn send(&self, msg: RpcMessage) {
        let _ = self.tx.send(msg);
    }

    pub fn respond(&self, id: RequestId, result: Result<Value, RpcError>) {
        self.send(match result {
            Ok(v) => RpcMessage::response(id, v),
            Err(e) => RpcMessage::error_response(Some(id), e),
        });
    }

    /// Sends a server-initiated request (string ids `s:<n>`, design §3) and
    /// waits for the client's response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let key = format!("s:{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(key.clone(), tx);
        self.send(RpcMessage::request(RequestId::Str(key), method, params));
        rx.await.unwrap_or_else(|_| {
            Err(RpcError::new(
                hy_protocol::error_code::INTERNAL_ERROR,
                "the client went away",
            ))
        })
    }

    /// Resolves a pending server-initiated request. Returns false for unknown ids.
    pub fn resolve(&self, id: &RequestId, result: Result<Value, RpcError>) -> bool {
        let key = match id {
            RequestId::Str(s) => s.clone(),
            RequestId::Int(i) => i.to_string(),
        };
        match self.pending.lock().remove(&key) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    pub fn fail_all(&self, message: &str) {
        let pending: Vec<_> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in pending {
            let _ = tx.send(Err(RpcError::new(
                hy_protocol::error_code::INTERNAL_ERROR,
                message,
            )));
        }
    }
}
