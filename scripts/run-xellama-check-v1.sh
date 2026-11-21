#!/bin/sh
# run-xellama-check-v1.sh - one-command regression gates for the
# XeLlama production shape (packaging after LarcXe's `larc check`:
# fixed inputs, baselines with margins, SKIP reported not hidden).
#
#   G1 counting   generation must equal the established reference
#                 sequence (16..55) - the project's determinism gate.
#   G2 perplexity WikiText-2, -c 4096 --chunks 8; baseline 6.4017
#                 (merged main, oneAPI 2026.2, 2026-11-20); PASS at
#                 <= baseline x 1.01 (LarcXe K3-style margin).
#                 WIKITEXT missing -> SKIP.
#   G3 speed      llama-bench tensor -ts 6/4 pp512 + tg128 at d0;
#                 floors pp512 >= 420 (measured 464.22), tg128 >=
#                 13.0 (measured ~14.3) on the production toggles.
#   G4 needle     SKIP by default: the needle harness is server-
#                 based and long; run the phase-2 runner separately.
#
# The production llama-server must be stopped first (script refuses
# otherwise). Exit status = number of FAILed gates (SKIP is not a
# failure). Run from ~/XeLlama.cpp:
#   sh scripts/run-xellama-check-v1.sh
# Defaults match the hand-over layout; override MODEL / BIN_DIR /
# WIKITEXT / OUT.

set -u

MODEL=${MODEL:-../llama.cpp/models/MTP/Qwen3.8-27B-QSA-Unsloth-UD-Q4_K_M.gguf}
BIN_DIR=${BIN_DIR:-../XeLlama.cpp/sycl/bin}
WIKITEXT=${WIKITEXT:-../llama.cpp/models/wikitext-2-raw/wiki.test.raw}
OUT=${OUT:-xellama-check-out}
COMPL="$BIN_DIR/llama-completion"
BENCH="$BIN_DIR/llama-bench"
PPLBIN="$BIN_DIR/llama-perplexity"

EXPECTED="16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,"
PPL_BASE=6.4017
PP_FLOOR=420
TG_FLOOR=13.0

die() { echo "ERROR: $*" >&2; exit 1; }

if pgrep -f "llama-server" >/dev/null 2>&1; then
  die "llama-server is running; stop the production server before the check."
fi
[ -f "$MODEL" ] || die "model not found: $MODEL (set MODEL=...)"
for b in "$COMPL" "$BENCH" "$PPLBIN"; do
  [ -x "$b" ] || die "binary not found: $b (set BIN_DIR=...)"
done

mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
{
  echo "xellama-check v1 - $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "model: $MODEL"
  echo "binaries: $BIN_DIR"
} > "$SUMMARY"

BASE_ENV="ZES_ENABLE_SYSMAN=1 GGML_SYCL_SPARSE_FA=1 GGML_SYCL_FA_ONEDNN=0 GGML_SYCL_DPAS_GEMM=0 GGML_SYCL_FA_DPAS_SG8=1 GGML_SYCL_SPARSE_FA_PREFILL=32"
FAILS=0
gate() { # $1 id, $2 result, $3 detail
  echo "GATE $1: $2 - $3" >> "$SUMMARY"
  echo "GATE $1: $2 - $3"
  [ "$2" = "FAIL" ] && FAILS=$((FAILS + 1))
  return 0
}

# bench t/s extractor: fields around the +/- marker (proven pattern).
bench_val() {
  row=$(grep "$2" "$1" | tail -n 1)
  [ -n "$row" ] || return 1
  v=$(printf '%s\n' "$row" | awk '{for (i=2; i<=NF; i++) if ($i == "±" || $i == "+/-") {print $(i-1); exit}}')
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

echo "== G1 counting"
env $BASE_ENV \
  "$COMPL" -m "$MODEL" -p "1, 2, 3,..., 15," -ngl 99 -fa 1 -sm tensor \
  -ctk q8_0 -ctv q4_0 -c 4096 --temp 0 --seed 42 -n 160 -no-cnv \
  --no-display-prompt \
  < /dev/null > "$OUT/g1-counting.log" 2>&1 || die "G1 run failed; see $OUT/g1-counting.log"
grep -v 'perf' "$OUT/g1-counting.log" | sed 's/^[0-9][0-9.]* [IW] //; s/[[:space:]]*$//' | grep -v '^$' \
  > "$OUT/g1-counting.txt"
ACTUAL=$(grep '^ *16, 17' "$OUT/g1-counting.txt" | head -1 | sed 's/^ *//; s/ *$//')
if [ "$ACTUAL" = "$EXPECTED" ]; then
  gate G1 PASS "counting generation identical to the reference"
else
  gate G1 FAIL "counting differs: got '${ACTUAL:-<none>}'"
fi

echo "== G2 perplexity"
if [ -f "$WIKITEXT" ]; then
  env $BASE_ENV \
    "$PPLBIN" -m "$MODEL" -f "$WIKITEXT" -c 4096 --chunks 8 -b 512 \
    -ngl 99 -ctk q8_0 -ctv q4_0 -fa on \
    > "$OUT/g2-ppl.log" 2>&1 || die "G2 run failed; see $OUT/g2-ppl.log"
  ppl=$(grep "Final estimate" "$OUT/g2-ppl.log" | tail -n 1 | grep -oE 'PPL = [0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -n 1)
  [ -n "$ppl" ] || die "no Final estimate PPL in $OUT/g2-ppl.log"
  ok=$(awk -v p="$ppl" -v b="$PPL_BASE" 'BEGIN { print (p <= b * 1.01) ? 1 : 0 }')
  if [ "$ok" = 1 ]; then
    gate G2 PASS "PPL $ppl <= $PPL_BASE x 1.01"
  else
    gate G2 FAIL "PPL $ppl > $PPL_BASE x 1.01"
  fi
else
  gate G2 SKIP "wikitext not found at $WIKITEXT (set WIKITEXT=...)"
fi

echo "== G3 speed floor"
env $BASE_ENV \
  "$BENCH" -m "$MODEL" -ngl 99 -fa 1 -sm tensor -ts 6/4 \
  -ctk q8_0 -ctv q4_0 -p 512 -n 128 -d 0 \
  > "$OUT/g3-bench.log" 2>&1 || die "G3 run failed; see $OUT/g3-bench.log"
pp=$(bench_val "$OUT/g3-bench.log" pp512) || die "no pp512 row in $OUT/g3-bench.log"
tg=$(bench_val "$OUT/g3-bench.log" tg128) || die "no tg128 row in $OUT/g3-bench.log"
ok=$(awk -v p="$pp" -v pf="$PP_FLOOR" -v t="$tg" -v tf="$TG_FLOOR" 'BEGIN { print (p >= pf && t >= tf) ? 1 : 0 }')
if [ "$ok" = 1 ]; then
  gate G3 PASS "pp512 $pp >= $PP_FLOOR, tg128 $tg >= $TG_FLOOR"
else
  gate G3 FAIL "pp512 $pp (floor $PP_FLOOR), tg128 $tg (floor $TG_FLOOR)"
fi

gate G4 SKIP "needle is server-based and long; run the phase-2 runner separately"

echo >> "$SUMMARY"
if [ "$FAILS" -eq 0 ]; then
  echo "VERDICT: all judged gates PASS" >> "$SUMMARY"
else
  echo "VERDICT: $FAILS gate(s) FAIL" >> "$SUMMARY"
fi
cat "$SUMMARY"
exit "$FAILS"
