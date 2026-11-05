//! CP-28: a minimal WebSocket endpoint (RFC 6455, text frames) so the exec
//! server can run as a separate process and be reached over the network.
//!
//! Only what JSON-RPC needs: the opening handshake (with a token check before
//! the upgrade), masked client frames, fragmentation, ping/pong and close.
//! Dependency-free apart from `base64`; SHA-1 (needed only for the accept key)
//! is implemented here.

use base64::Engine as _;
use tokio::io::AsyncReadExt;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// Larger messages close the connection (1009).
pub const MAX_MESSAGE: usize = 16 * 1024 * 1024;

/// SHA-1 of `data` (FIPS 180-4). Used for `Sec-WebSocket-Accept` only.
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn accept_key(key: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(sha1(format!("{key}{GUID}").as_bytes()))
}

/// The parts of the upgrade request the server checks.
#[derive(Debug, Default)]
pub struct Upgrade {
    pub path: String,
    pub key: Option<String>,
    pub version: Option<String>,
    pub upgrade: Option<String>,
    pub authorization: Option<String>,
    pub origin: Option<String>,
}

impl Upgrade {
    /// `?token=` from the path, else a `Bearer` header.
    pub fn token(&self) -> Option<String> {
        let query = self.path.split_once('?').map(|(_, q)| q).unwrap_or("");
        for pair in query.split('&') {
            if let Some(value) = pair.strip_prefix("token=") {
                return Some(percent_decode(value));
            }
        }
        self.authorization
            .as_deref()
            .and_then(|a| a.strip_prefix("Bearer "))
            .map(str::to_owned)
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses the request head (up to the blank line).
pub fn parse_upgrade(head: &str) -> Option<Upgrade> {
    let mut lines = head.split("\r\n");
    let request = lines.next()?;
    let mut parts = request.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let mut up = Upgrade {
        path: parts.next()?.to_owned(),
        ..Upgrade::default()
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_owned();
        match name.trim().to_ascii_lowercase().as_str() {
            "sec-websocket-key" => up.key = Some(value),
            "sec-websocket-version" => up.version = Some(value),
            "upgrade" => up.upgrade = Some(value),
            "authorization" => up.authorization = Some(value),
            "origin" => up.origin = Some(value),
            _ => {}
        }
    }
    Some(up)
}

/// Reads the HTTP request head (at most 16 KiB).
pub async fn read_head<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() > 16 * 1024 {
            return Err(std::io::Error::other("request head too large"));
        }
        if reader.read(&mut byte).await? == 0 {
            return Err(std::io::Error::other(
                "connection closed during the handshake",
            ));
        }
        buf.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Constant-time comparison for the token.
pub fn same_token(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An unmasked server frame.
pub fn encode_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | (opcode & 0x0f));
    let len = payload.len();
    if len < 126 {
        frame.push(len as u8);
    } else if len < 65_536 {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

pub enum Incoming {
    Text(String),
    Ping(Vec<u8>),
    Close,
}

/// Reads frames until a whole message (or a control frame) is available.
pub async fn read_message<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<Incoming> {
    let mut message: Vec<u8> = Vec::new();
    loop {
        let mut head = [0u8; 2];
        reader.read_exact(&mut head).await?;
        let fin = head[0] & 0x80 != 0;
        let opcode = head[0] & 0x0f;
        let masked = head[1] & 0x80 != 0;
        let mut len = u64::from(head[1] & 0x7f);
        if len == 126 {
            let mut ext = [0u8; 2];
            reader.read_exact(&mut ext).await?;
            len = u64::from(u16::from_be_bytes(ext));
        } else if len == 127 {
            let mut ext = [0u8; 8];
            reader.read_exact(&mut ext).await?;
            len = u64::from_be_bytes(ext);
        }
        if !masked {
            return Err(std::io::Error::other("unmasked client frame"));
        }
        if len as usize > MAX_MESSAGE || message.len() + len as usize > MAX_MESSAGE {
            return Err(std::io::Error::other("message too big"));
        }
        let mut mask = [0u8; 4];
        reader.read_exact(&mut mask).await?;
        let mut payload = vec![0u8; len as usize];
        reader.read_exact(&mut payload).await?;
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
        match opcode {
            0x0 | 0x1 => {
                message.extend_from_slice(&payload);
                if fin {
                    return Ok(Incoming::Text(
                        String::from_utf8_lossy(&message).into_owned(),
                    ));
                }
            }
            0x8 => return Ok(Incoming::Close),
            0x9 => return Ok(Incoming::Ping(payload)),
            0xa => {}
            _ => return Err(std::io::Error::other("unsupported frame")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_and_accept_key_match_the_rfc() {
        let hex: String = sha1(b"abc").iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
        // RFC 6455 §1.3.
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn upgrade_request_and_token() {
        let head = "GET /exec?token=a%2Bb HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n";
        let up = parse_upgrade(head).unwrap_or_default();
        assert_eq!(up.token().as_deref(), Some("a+b"));
        assert_eq!(up.key.as_deref(), Some("k"));
        let bearer = parse_upgrade("GET / HTTP/1.1\r\nAuthorization: Bearer t0k\r\n\r\n")
            .unwrap_or_default();
        assert_eq!(bearer.token().as_deref(), Some("t0k"));
        assert!(parse_upgrade("POST / HTTP/1.1\r\n\r\n").is_none());
        assert!(same_token("abc", "abc"));
        assert!(!same_token("abc", "abd"));
        assert!(!same_token("abc", "ab"));
    }

    #[tokio::test]
    async fn frames_round_trip() -> std::io::Result<()> {
        // A masked client frame for "hi".
        let mask = [1u8, 2, 3, 4];
        let mut frame = vec![0x81, 0x80 | 2];
        frame.extend_from_slice(&mask);
        frame.extend(b"hi".iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        let mut reader: &[u8] = &frame;
        match read_message(&mut reader).await? {
            Incoming::Text(t) => assert_eq!(t, "hi"),
            _ => return Err(std::io::Error::other("expected text")),
        }
        let long = vec![b'x'; 300];
        let encoded = encode_frame(0x1, &long);
        assert_eq!(encoded[1], 126);
        assert_eq!(encoded.len(), 4 + 300);
        Ok(())
    }
}
