# Scripts added by this fork

## Capacity planner (`run-capacity-plan-v1.sh`)

Prints a preflight table of estimated per-card VRAM residency and
headroom by context length and KV cache type, for this fork's
production shape (Arc Pro B60 + A770, tensor split 6/4). The table is
anchored to a measured residency (2026-11-15: B60 18.5 GiB /
A770 14.2 GiB at 262,144 tokens with q8_0/q4_0 KV); only the KV term
is scaled. Pure arithmetic - no GPU access needed, runs anywhere.

```sh
sh scripts/run-capacity-plan-v1.sh            # q8_0/q4_0 table
KV=q8q8 sh scripts/run-capacity-plan-v1.sh    # KV: f16|q8q8|q8q4|q4q4
```

Verdicts: OK, TIGHT (under 2 GiB headroom), OVER. The script also
prints the largest context that keeps at least 1 GiB of headroom on
both cards. If the model or the split changes, re-anchor the
constants at the top of the script from a fresh measurement.

## Regression gates (`run-xellama-check-v1.sh`)

One-command regression gates for the production shape. Stop the
production server first; the script refuses to run while
llama-server is up.

```sh
sh scripts/run-xellama-check-v1.sh
```

- G1 counting: the generation must match the reference sequence.
- G2 perplexity: WikiText-2, baseline 6.4017 with a +1% margin;
  SKIP when the corpus file is missing.
- G3 speed floors: llama-bench, tensor split, pp512 >= 420 t/s and
  tg128 >= 13.0 t/s.
- G4 needle: reported as SKIP (the needle harness is server-based
  and long; run it separately).

Exit status is the number of failed gates; SKIP is not a failure.
Paths can be overridden with MODEL / BIN_DIR / WIKITEXT / OUT.

---

# このフォークで追加したスクリプト

## 容量プランナ（`run-capacity-plan-v1.sh`）

このフォークの本番形状（Arc Pro B60 + A770、tensor split 6/4）に
ついて、文脈長と KV キャッシュ型ごとのカード別常駐量と headroom
の目安を、起動前に表で出します。実測の常駐量（2026-11-15、
262,144 トークン・q8_0/q4_0 で B60 18.5 GiB / A770 14.2 GiB）を
アンカーに、KV 項だけをスケールさせる方式です。純粋な算術なので
GPU は不要で、どこでも実行できます。

```sh
sh scripts/run-capacity-plan-v1.sh            # q8_0/q4_0 の表
KV=q8q8 sh scripts/run-capacity-plan-v1.sh    # KV: f16|q8q8|q8q4|q4q4
```

判定は OK / TIGHT（headroom 2 GiB 未満）/ OVER で、両カードに
1 GiB 以上の headroom を保てる最大文脈も出します。モデルや
split を変えたら、スクリプト冒頭の定数を新しい実測で
アンカーし直してください。

## 回帰ゲート（`run-xellama-check-v1.sh`）

本番形状の回帰ゲートを一括で回します。本番サーバーを先に
止めてください（llama-server が動いている間はスクリプトが
拒否します）。

```sh
sh scripts/run-xellama-check-v1.sh
```

- G1 counting: 生成が参照列と一致すること。
- G2 perplexity: WikiText-2、基準 6.4017 に +1% のマージン。
  コーパスが無ければ SKIP。
- G3 速度下限: llama-bench、tensor split で pp512 >= 420 t/s、
  tg128 >= 13.0 t/s。
- G4 needle: SKIP として報告（needle はサーバー方式で長く
  かかるため、別途実行）。

終了コードは FAIL したゲートの数で、SKIP は失敗に数えません。
パスは MODEL / BIN_DIR / WIKITEXT / OUT で上書きできます。
