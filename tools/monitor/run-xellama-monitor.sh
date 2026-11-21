#!/bin/sh
# Starts the XeLlama Monitor as one process on :11435:
# xellama-gpu-telemetry serves this directory's web UI at /,
# the GPU snapshot at /gpu.json, and proxies llama-server's
# /props, /metrics and /slots on the same origin, so the page
# needs no base-URL setup.
#
# Both build artifacts are produced with docker, so the host
# needs neither node/npm nor a Go toolchain:
# - the telemetry binary, when telemetry/xellama-gpu-telemetry.go
#   is newer than the binary (Dockerfile.telemetry)
# - the web assets, when monitor.ts is newer than the built
#   monitor.js (Dockerfile.monitor-web)
# Set BIN explicitly to use your own binary and skip its build.
#
# Env overrides:
#   BIN     telemetry binary  (default: next to this script)
#   WEBDIR  built web assets  (default: <script dir>/monitor-web)
#   LLAMA   llama-server base (default http://127.0.0.1:11434)
# Any extra arguments are passed through to the telemetry binary.
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WEBDIR=${WEBDIR:-"$SCRIPT_DIR/monitor-web"}
LLAMA=${LLAMA:-"http://127.0.0.1:11434"}
SRC=$SCRIPT_DIR

if [ -z "${BIN:-}" ]; then
  BIN="$SCRIPT_DIR/xellama-gpu-telemetry"
  TELEMETRY_SRC="$SCRIPT_DIR/telemetry/xellama-gpu-telemetry.go"
  if [ ! -f "$BIN" ] || [ "$TELEMETRY_SRC" -nt "$BIN" ]; then
    echo "building telemetry binary with docker..."
    docker build -q -t xellama-telemetry -f "$SCRIPT_DIR/Dockerfile.telemetry" "$SCRIPT_DIR" >/dev/null
    docker run --rm -v "$SCRIPT_DIR/telemetry:/src:ro" -v "$SCRIPT_DIR:/out" xellama-telemetry
    echo "built: $BIN"
  fi
fi

if [ ! -f "$WEBDIR/monitor.js" ] || [ "$SRC/monitor.ts" -nt "$WEBDIR/monitor.js" ]; then
  echo "building monitor web assets with docker..."
  mkdir -p "$WEBDIR"
  docker build -q -t xellama-monitor-web -f "$SCRIPT_DIR/Dockerfile.monitor-web" "$SCRIPT_DIR" >/dev/null
  docker run --rm -v "$SRC:/src:ro" -v "$WEBDIR:/out" xellama-monitor-web
  echo "built: $WEBDIR/monitor.js"
fi

exec "$BIN" -llama "$LLAMA" -web "$WEBDIR" "$@"
