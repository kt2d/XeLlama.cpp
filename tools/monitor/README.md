# XeLlama Monitor

A Strata-style dashboard for llama-server on the XeLlama stack:
model state, decode and prefill speed (cumulative averages),
DFlash draft acceptance, context usage, per-slot prompt/generated
text, and live GPU cards (VRAM, busy, frequency) for Intel Arc
cards on the xe driver.

## How it works

One process serves everything. `xellama-gpu-telemetry` listens on
:11435 and

- serves this web UI at `/`,
- serves a GPU snapshot at `/gpu.json`, sampled every 2 s from the
  xe driver's DRM fdinfo of the llama-server process plus GT
  frequency sysfs,
- proxies llama-server's `/props`, `/metrics` and `/slots` from
  :11434 on the same origin.

The page fetches relative paths only, so there is no server URL to
configure. Just open `http://<host>:11435`.

Per-slot prompt/generated text appears only when llama-server runs
with `LLAMA_SERVER_SLOTS_DEBUG=1`; otherwise the monitor shows
metrics only. llama.cpp keeps no request history, so the slot view
shows each slot's current or most recent task only.

## Run

Requirements: docker (both builds run in containers; the host
needs neither node/npm nor a Go toolchain) and a running
llama-server.

```
sh tools/monitor/run-xellama-monitor.sh
```

The launcher rebuilds whichever artifact is stale, with docker:

- the telemetry binary, when `telemetry/xellama-gpu-telemetry.go`
  is newer than the binary (`Dockerfile.telemetry`),
- the web assets, when `monitor.ts` is newer than the built
  `monitor.js` (`Dockerfile.monitor-web`).

Generated artifacts (the binary, `monitor.js`, `monitor-web/`) are
gitignored.

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `BIN` | next to the script | telemetry binary to run; setting it skips the binary build |
| `WEBDIR` | `<script dir>/monitor-web` | built web assets directory |
| `LLAMA` | `http://127.0.0.1:11434` | llama-server base URL to proxy |

Extra arguments pass through to the telemetry binary
(`-addr`, `-interval`, `-pid`, `-llama`, `-web`, `-proc`, `-sys`).
The llama-server PID is auto-discovered; use `-pid` to pin it.

## GPU telemetry notes

VRAM capacity comes from a built-in usable-capacity table for
known cards (Arc Pro B60 23.97 GiB, Arc A770 15.91 GiB), with the
largest PCI BAR as a fallback for unknown cards; the JSON field
`vram_total_source` says which was used. Busy percentages are
computed from the xe fdinfo cycle counters (CCS = compute,
BCS = copy engine).

## Files

- `monitor.ts`, `index.html`, `monitor.css` — the web UI
- `telemetry/xellama-gpu-telemetry.go` — the single-origin server
- `Dockerfile.monitor-web`, `Dockerfile.telemetry` — docker builds
- `run-xellama-monitor.sh` — launcher

---

# XeLlama Monitor（日本語）

XeLlama スタック上の llama-server 向け、Strata 風ダッシュボード。
モデル状態、デコード／プリフィル速度（累積平均）、DFlash の
ドラフト受理率、コンテキスト使用率、スロットごとのプロンプト／
生成テキストに加え、xe ドライバ上の Intel Arc 向け GPU カード
（VRAM・busy・周波数）を表示します。

## 仕組み

配信は1プロセスです。`xellama-gpu-telemetry` が :11435 で待ち受け、

- この Web UI を `/` で配信し、
- GPU スナップショットを `/gpu.json` で配信します（llama-server
  プロセスの xe DRM fdinfo と GT 周波数 sysfs を 2 秒間隔で
  サンプリング）、
- llama-server（:11434）の `/props`・`/metrics`・`/slots` を
  同一 origin で proxy します。

ページは相対パスでしか引かないため、サーバ URL の設定は不要です。
`http://<ホスト>:11435` を開くだけで使えます。

スロットのプロンプト／生成テキストは、llama-server 側で
`LLAMA_SERVER_SLOTS_DEBUG=1` を付けた場合のみ表示されます
（なければメトリクスのみ）。llama.cpp はリクエスト履歴を保持
しないため、スロット表示は各スロットの現在／直近のタスクだけです。

## 起動

必要なのは docker だけです（ビルドは両方ともコンテナ内で行い、
ホストに node/npm も Go ツールチェインも要りません）。llama-server
が起動している状態で：

```
sh tools/monitor/run-xellama-monitor.sh
```

ラッパーは、古くなっている生成物だけを docker で再ビルドします：

- テレメトリのバイナリ：`telemetry/xellama-gpu-telemetry.go` が
  バイナリより新しいとき（`Dockerfile.telemetry`）
- Web アセット：`monitor.ts` がビルド済み `monitor.js` より
  新しいとき（`Dockerfile.monitor-web`）

生成物（バイナリ、`monitor.js`、`monitor-web/`）は gitignore 済みです。

環境変数での上書き：

| 変数 | 既定値 | 意味 |
|---|---|---|
| `BIN` | スクリプトの隣 | 使うテレメトリバイナリ。指定するとバイナリのビルドを省略 |
| `WEBDIR` | `<スクリプトの場所>/monitor-web` | ビルド済み Web アセットの置き場所 |
| `LLAMA` | `http://127.0.0.1:11434` | proxy 先の llama-server |

追加の引数はテレメトリバイナリにそのまま渡ります
（`-addr`、`-interval`、`-pid`、`-llama`、`-web`、`-proc`、`-sys`）。
llama-server の PID は自動検出です（固定する場合は `-pid`）。

## GPU テレメトリの注記

VRAM 容量は、既知カード向けの実効容量テーブル（Arc Pro B60
23.97 GiB、Arc A770 15.91 GiB）を優先し、未知のカードでは最大の
PCI BAR にフォールバックします。どちらを使ったかは JSON の
`vram_total_source` に出ます。busy % は xe fdinfo の cycles
カウンタから算出します（CCS = 計算、BCS = コピーエンジン）。

## ファイル

- `monitor.ts`、`index.html`、`monitor.css` — Web UI
- `telemetry/xellama-gpu-telemetry.go` — 単一 origin サーバ
- `Dockerfile.monitor-web`、`Dockerfile.telemetry` — docker ビルド
- `run-xellama-monitor.sh` — 起動ラッパー
