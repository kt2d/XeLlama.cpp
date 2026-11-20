# Tools added by this fork

## XeLlama Monitor (`monitor/`)

A Strata-style monitoring dashboard for llama.cpp server. It is a plain
static page: open it in a browser and it polls the server every 2 seconds.
No build step for the page itself and no server-side changes are required.

Files:

- `monitor/index.html` - page markup; loads `monitor.css` and `monitor.js`
- `monitor/monitor.css` - styles
- `monitor/monitor.ts` - dashboard logic (TypeScript source)
- `monitor/monitor.js` - compiled output of `monitor.ts` (generated, not in git)

Build:

```sh
cd tools/monitor
tsc monitor.ts        # TypeScript 5, target ES2020, no modules, no dependencies
```

Usage:

- Open `monitor/index.html` in a browser on a machine that can reach the
  llama.cpp server.
- The default server URL is `http://192.168.0.17:11434`. It can be changed
  in the header; the value is kept in the browser's local storage.

Data sources (all read-only GET requests):

- `/props` - model path, slot count, context size
- `/metrics` - Prometheus metrics (the server must run with `--metrics`):
  decode/prompt throughput, token totals, and the speculative-decoding
  counters including per-position draft acceptance
- `/slots` - per-slot state: prompt progress, generated count, remaining
  tokens, and - only when the server runs with
  `LLAMA_SERVER_SLOTS_DEBUG=1` in its environment - the prompt and
  generated text of the current/last task

Notes:

- llama.cpp keeps no request history, so the dashboard can only show the
  current/last task per slot. There are no model load/unload controls:
  llama.cpp server has no such endpoints.
- Everything is fetched by the browser directly from the server; nothing
  leaves the local network.

---

# このフォークで追加したツール

## XeLlama Monitor（`monitor/`）

llama.cpp server 向けの Strata 風モニターダッシュボードです。通常の
静的ページで、ブラウザで開くとサーバーを2秒ごとにポーリングします。
ページ自体にビルド手順は不要で、サーバー側の変更も要りません。

ファイル:

- `monitor/index.html` - ページ本体。`monitor.css` と `monitor.js` を読みます
- `monitor/monitor.css` - スタイル
- `monitor/monitor.ts` - ダッシュボードのロジック（TypeScript ソース）
- `monitor/monitor.js` - `monitor.ts` のコンパイル結果（生成物、git には含めません）

ビルド:

```sh
cd tools/monitor
tsc monitor.ts        # TypeScript 5、target ES2020、モジュールなし、依存なし
```

使い方:

- llama.cpp サーバーに届くマシンのブラウザで `monitor/index.html` を開きます。
- 既定のサーバー URL は `http://192.168.0.17:11434` です。ヘッダーで
  変更でき、値はブラウザの local storage に保存されます。

データソース（すべて読み取り専用の GET）:

- `/props` - モデルのパス、スロット数、コンテキストサイズ
- `/metrics` - Prometheus メトリクス（サーバー側で `--metrics` が必要）:
  デコード／プロンプトのスループット、トークン総量、投機デコードの
  カウンタ（位置別のドラフト受理数を含む）
- `/slots` - スロットごとの状態： プロンプト処理数、生成数、残り
  トークン数、そしてサーバーの環境変数に `LLAMA_SERVER_SLOTS_DEBUG=1`
  がある場合に限って、現在／直近タスクのプロンプトと生成テキスト

注意:

- llama.cpp はリクエスト履歴を保持しないため、表示できるのはスロット
  ごとの現在／直近のタスクまでです。モデルのロード／アンロード操作は
  ありません（llama.cpp server に該当するエンドポイントがありません）。
- 取得はすべてブラウザからサーバーへ直接行われ、ローカルネットワークの
  外に出ることはありません。
