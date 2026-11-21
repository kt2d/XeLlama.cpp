#!/bin/sh
# run-capacity-plan-v1.sh - preflight capacity planner for the
# production shape (LarcXe-style: print the table BEFORE loading).
#
# Anchored to the user's own measurement, not a model of the stack:
#   2026-11-15, production server at full context 262144,
#   -ts 6,4, -ctk q8_0 -ctv q4_0, DFlash ownhead drafter on SYCL0:
#     B60 resident 18.5 GiB, A770 resident 14.2 GiB.
# The KV term is the only part that scales with context / cache type;
# everything else (weights at this split, drafter, buffers) is held at
# the anchor. residency(card) = anchor - anchor_KV(card) + KV(card).
#
# KV per token (Qwen3.8-27B: 16 full-attention layers, 4 KV heads,
# head_dim 256): f16/f16 64.0 KiB, q8_0/q8_0 34.0, q8_0/q4_0 26.0,
# q4_0/q4_0 18.0. Split shares from -ts 6,4: B60 0.6, A770 0.4.
#
# Pure arithmetic: runs anywhere, no GPU access, seconds.
#   sh scripts/run-capacity-plan-v1.sh            # q8_0/q4_0 table
#   KV=q8q8 sh scripts/run-capacity-plan-v1.sh    # other cache types
# KV in {f16, q8q8, q8q4, q4q4}. Verdicts: headroom >= 2 GiB OK,
# 0..2 TIGHT (the anchor state itself runs TIGHT on the A770),
# < 0 OVER.

set -u

KV=${KV:-q8q4}
case "$KV" in
  f16)  KIB=64.0 ;;
  q8q8) KIB=34.0 ;;
  q8q4) KIB=26.0 ;;
  q4q4) KIB=18.0 ;;
  *) echo "ERROR: KV must be f16|q8q8|q8q4|q4q4" >&2; exit 1 ;;
esac

echo "capacity-plan v1 - KV=$KV ($KIB KiB/token), split 6/4, anchor 2026-11-15 (B60 18.5 / A770 14.2 GiB @262144 q8_0/q4_0)"
echo
awk -v kib="$KIB" 'BEGIN {
  anchor_ctx = 262144; anchor_kib = 26.0
  b60_anchor = 18.5; a770_anchor = 14.2
  b60_cap = 24.0; a770_cap = 16.0
  share_b = 0.6; share_a = 0.4
  kv_anchor = anchor_ctx * anchor_kib / 1048576.0
  b60_base = b60_anchor - kv_anchor * share_b
  a770_base = a770_anchor - kv_anchor * share_a
  printf "%-9s %10s %10s %10s %10s %s\n", "ctx", "B60 GiB", "B60 head", "A770 GiB", "A770 head", "verdict"
  n = split("32768 65536 131072 262144 393216 524288", ctxs, " ")
  for (i = 1; i <= n; i++) {
    ctx = ctxs[i]
    kv = ctx * kib / 1048576.0
    b = b60_base + kv * share_b; a = a770_base + kv * share_a
    hb = b60_cap - b; ha = a770_cap - a
    v = "OK"; if (hb < 2 || ha < 2) v = "TIGHT"; if (hb < 0 || ha < 0) v = "OVER"
    printf "%-9d %10.2f %10.2f %10.2f %10.2f %s\n", ctx, b, hb, a, ha, v
  }
  # Max ctx keeping >= 1 GiB headroom on both cards (tight card wins).
  per_b = kib / 1048576.0 * share_b; per_a = kib / 1048576.0 * share_a
  maxb = (b60_cap - 1.0 - b60_base) / per_b
  maxa = (a770_cap - 1.0 - a770_base) / per_a
  m = (maxb < maxa) ? maxb : maxa
  printf "\nmax ctx with >=1 GiB headroom on both cards: ~%d tokens (%s-limited)\n", int(m), (maxb < maxa) ? "B60" : "A770"
  printf "non-KV base implied by the anchor: B60 %.2f GiB, A770 %.2f GiB\n", b60_base, a770_base
}'
