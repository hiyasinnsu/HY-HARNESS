# hy-protocol/1 リファレンスとクライアントの書き方（CP-43）

HY-HARNESS の CLI・GUI のデーモン・SDK・ACP は同じ面 **hy-protocol/1**（JSON-RPC 2.0）を使います。このページだけでクライアントを書けるようにしています。メソッドの機械可読な一覧は [`protocol-methods.json`](protocol-methods.json)（`pnpm check:protocol-methods` で実装と照合）です。

## 1. つなぐ

| 経路 | 起動 | 認証 | 用途 |
| :--- | :--- | :--- | :--- |
| stdio | `hy protocol serve [--mock] [--cwd …]` | 不要（起動した親を信頼） | 1 クライアント専用 |
| 名前付きパイプ | `hy serve start --daemon --json` | `initialize` の `params.token` | 常駐デーモン、複数クライアント |
| WebSocket | `hy serve start --daemon --ws 0 --json` | 接続時 `?token=…`（または `Authorization: Bearer`、サブプロトコル `hy-protocol.<token>`） | ブラウザ・他ツール |

- `hy serve start --daemon --json` は冪等です。動いていれば既存のデーモンの `{pid, pipe, ws, token, workspace}` を返し、無ければ起動してから返します。デーモンはワークスペース（状態ディレクトリ）ごとに 1 つです。
- WebSocket は既定でループバックのみです。他のマシンからは `--host 0.0.0.0 --allow-remote` が必要で、その場合もトークンは必須です。
- 経路はどれも「1 行（WebSocket なら 1 メッセージ）= 1 JSON-RPC メッセージ」です。

## 2. 最小の会話

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"hy-protocol/1","token":"<daemon token>"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"hy-protocol/1","serverInfo":{"name":"hy-harness","version":"0.4.0","apiVersion":"hy-api/1"},"capabilities":{"threads":true,"turns":true,"approvals":true,"config":true,"multiClient":true}}}

→ {"jsonrpc":"2.0","id":2,"method":"turn/start","params":{"message":"README を要約して","tag":"t1"}}
← {"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"run-1a2b3c4d5e6f","tag":"t1"}}
← {"jsonrpc":"2.0","method":"turn/event","params":{"threadId":"run-1a2b3c4d5e6f","tag":"t1","event":{"type":"tool-start","name":"read_file",…}}}
← {"jsonrpc":"2.0","method":"approval/request","params":{"id":"approval-1","command":"npm install","sandbox":"workspace-write"}}
→ {"jsonrpc":"2.0","id":3,"method":"approval/respond","params":{"id":"approval-1","approved":false}}
← {"jsonrpc":"2.0","id":2,"result":{"threadId":"run-1a2b3c4d5e6f","final":"…"}}
```

- `turn/start` の応答は**ターンが終わったとき**に返ります。その間も同じ接続で `approval/respond`・`turn/steer`・`turn/cancel` を送れます（サーバーは行を並行に処理します）。
- `tag` は任意の文字列で、`turn/started` と `turn/event` にそのまま付いて返ります。1 本の接続で複数のターンを走らせるときの対応づけに使います。
- 続きのターンは `turn/start` に `threadId` を付けます。スレッドはワークスペースのセッションログ（`session.v1.jsonl` の run）で、GUI・CLI・ACP と共通です。

## 3. メソッド

| メソッド | 向き | 内容 |
| :--- | :--- | :--- |
| `initialize` | → | 版の交渉。デーモンではトークンをここで渡す |
| `thread/list` `{limit?}` | → | スレッド一覧（新しい順） |
| `thread/read` `{threadId, offset?, limit?}` | → | トランスクリプト（ページング、`total`・`title` 付き） |
| `turn/start` `{message, threadId?, images?, tag?}` | → | 1 ターン実行 → `{threadId, final}` |
| `turn/cancel` / `turn/steer` / `turn/status` `{threadId}` | → | 実行中ターンの中止・追記・状態 |
| `approval/respond` `{id, approved}` | → | 承認依頼への回答（5 分で自動拒否） |
| `config/get` | → | 実効設定（モデル、サンドボックス、承認ポリシー、機能、MCP、プラグイン） |
| `config/set` `{key, value}` | → | 実行時に変更：`model`・`approvalPolicy`・`autoApprove`・`fullAuto` |
| `model/set` `{model, threadId?}` | → | モデル切替（新規と読み込み済みのスレッド、または 1 スレッド） |
| `mcpServer/reload` / `plugin/reload` | → | 設定を読み直して MCP サーバー・プラグインを再起動（再起動不要） |
| `turn/started` `{threadId, tag?}` | ← | ターン開始（新規スレッドの ID が分かる） |
| `turn/event` `{threadId, tag?, event}` | ← | エージェントのイベント（assistant / tool-start / tool / tool-error / thinking …） |
| `approval/request` `{id, command, sandbox?, justification?}` | ← | 承認が必要 |
| `approval/expired` `{id}` | ← | 回答が無く拒否された |

## 4. エラー

| コード | 意味 |
| :--- | :--- |
| -32700 / -32600 / -32601 / -32602 / -32603 | JSON-RPC 標準（解析・不正要求・未知メソッド・不正パラメータ・内部） |
| -32001 | 未認証（トークンが無い・違う） |
| -32002 | スレッド使用中（別のクライアントがそのスレッドのターンを実行中） |

## 5. SDK を使う

### TypeScript（`packages/sdk`）

```ts
import { connectDaemon, ProtocolClient } from '@hy/sdk'

// デーモンを見つける（無ければ起動）。切断されても次の呼び出しで再接続する。
const client = await connectDaemon({ cli: 'hy', cwd: 'C:/repo', onApproval: (req) => req.command.startsWith('npm test') })
const { threadId, final } = await client.turn('テストを直して', { onEvent: (event) => console.log(event.type) })
await client.turn('ログも短くして', { threadId })
await client.setModel('qwen2.5:7b')
await client.close()

// 1 回限りなら stdio でも：
const c = await ProtocolClient.connect({ kind: 'stdio', cli: 'hy', cwd: 'C:/repo', args: ['--mock'] })
```

### Python（`python/hy_harness`）

```python
from hy_harness import ProtocolClient

with ProtocolClient(cli="hy", cwd="C:/repo", on_approval=lambda req: False) as c:
    c.initialize()
    r = c.turn("README を要約して", on_event=lambda event, thread: print(event.get("type")))
    print(r["final"])
```

Python は stdio のみです（標準ライブラリに WebSocket クライアントが無いため）。デーモンに常駐でつなぐときは TypeScript SDK を使います。実行例は `python/examples/protocol_run.py`。

## 6. 別プロセスの実行デーモン（CP-28）

`hy-exec-server` は単独でも待ち受けられます。

```powershell
hy-exec-server --listen ws://127.0.0.1:8765 --token <秘密の文字列>
$env:HY_EXEC_URL = "ws://127.0.0.1:8765"; $env:HY_EXEC_TOKEN = "<同じ文字列>"
hy run "…"   # このコマンドは上の exec server でコマンドを実行する
```

トークンが無い・違う接続は 401 で拒否されます。ループバック以外は `--allow-remote` が必要です。

## 7. ACP

`hy acp` は ACP v1（エディタ向け）を同じホストで動かします。ACP のセッションはそのまま hy-protocol のスレッドで、`thread/list` に現れます。
