# Appendix: DFlash speculative decoding

Notes from running the DFlash2 drafter (`--spec-type draft-dflash`)
with this fork on a heterogeneous Intel Arc setup. Everything below
was measured on: Arc Pro B60 (24 GiB, PCIe x8) + Arc A770 (16 GiB,
PCIe x4), xe driver, tensor split `-ts 6,4`, target
`Qwen3.8-27B UD-Q4_K_M`, KV `-ctk q8_0 -ctv q4_0`, oneAPI 2026.2.
Other combinations may behave differently; two of the three issues
below are shape problems, not hardware limits, so the fixes are
worth trying before concluding anything about a different setup.

## Working configuration (cheat sheet)

Add to the server command:

```
-md <drafter>-ownhead.gguf \
--spec-type draft-dflash --spec-draft-n-max 3 \
--spec-draft-n-ubatch 256 \
-devd SYCL0 -ngld 99
```

and set `LLAMA_DFLASH_DEV=0` in the environment. The `-ownhead`
drafter is the stock DFlash2 GGUF plus its own `output.weight`
(see issue 1). With this shape the production server (262,144-token
slots) starts cleanly and the log shows `draft acceptance` lines;
a representative acceptance over normal traffic was 44.2%
(102 accepted / 231 drafted). If no acceptance line appears after
the first generation, the speculative path is not engaged.

## Issue 1: tensor split aborts at load (the shared lm_head)

Symptom: deterministic abort during model load, before any
generation:

```
ggml-backend-meta.cpp: GGML_ASSERT(src_ss[0].axis != GGML_BACKEND_SPLIT_AXIS_0) failed
```

Root cause: the DFlash2 drafter ships without its own lm_head and
reuses the target's. Under tensor split the lm_head weight is split
along axis 0, so the logits are axis-0-split too  -  and the
drafter's selector begins with a TOP_K over those logits. TOP_K is
a per-row op in the Meta backend, and per-row ops assert against
axis-0-split inputs. Single-device runs are unaffected, which is
why the failure looks like a tensor-split bug; it is a graph-shape
problem.

Fix (GGUF side, no code change): give the drafter its own
`output.weight`, copied byte-exact (no requantization) from the
target GGUF, and load that file as the drafter. The assert
disappears and acceptance/mean-length match the single-device
reference, confirming the copy is numerically transparent. Cost:
about +1.35 GB on the drafter's device for the Q8_0 head of this
model pair.

## Issue 2: draft reserve refused at full context (B1)

Symptom: at the production context (262,144, no `-c` cap) the
server refuses to start: the draft context's scheduler reserve does
not fit.

Root cause: the draft context inherits the target's `n_ubatch`
(2048), and the reserve is sized for the worst case
`min(n_ctx, n_ubatch)`  -  about 4.1 GiB across the compute buffers
for this pair. The actual draft work per step is `n_max + 1` rows,
so the reserve is almost all slack.

Fix (no code change): `--spec-draft-n-ubatch 256`. The reserve
shrinks roughly in proportion and the server starts at full
context. Note that 256 also measured *faster* than 512, with
higher acceptance on the same prompt (mechanism not identified;
recorded as an observation). Caution when reproducing: diagnostic
runs that pass an explicit smaller `-c` change the reserve outcome
and will hide this failure entirely.

## Measured effect (n-max 3, ubatch 256, ownhead drafter)

| cell | control | DFlash | delta |
| --- | --- | --- | --- |
| short prompt | 14.40 t/s | 20.39 t/s | +42% |
| long prompt (~40,120 tokens) | 14.12 t/s | 17.39 t/s | +23% |

Production sighting after adoption: first generation 217 tokens at
18.13 t/s against a ~14.4 t/s non-speculative baseline. Acceptance
is content-dependent (0.53-0.71 across the measured cells; 44.2%
representative in mixed traffic). Prefill pays a small tax for
target-feature extraction (about -7% in one long-prompt cell).

## Not adopted / open ends

- MTP was evaluated separately and not adopted: at long context its
  decode falls below the DFlash shape (below 4 t/s past ~200k
  tokens in this setup). Speculation raises peak throughput; it
  does not remove the depth-dependent KV-read cost.
- The combination with `--ctx-checkpoints` was not part of the
  measurement cells; the production command keeps checkpoints on,
  and the acceptance line in the log is the check that both are
  active.
- A per-row debug patch used during diagnosis is not part of this
  fork's stack; do not carry diagnostic patches into a production
  build.
