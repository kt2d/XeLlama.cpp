// XeLlama Monitor - Strata-style dashboard for a llama.cpp server.
//
// Data sources (polled every 2 s from the browser):
//   GET /props   - model path, slot count, context size
//   GET /metrics - Prometheus text (requires the server's --metrics flag)
//   GET /slots   - per-slot state; prompt/generated text is included only
//                  when the server runs with LLAMA_SERVER_SLOTS_DEBUG=1
//
// Build: tsc monitor.ts   (produces monitor.js, loaded by index.html)
// No modules and no runtime dependencies; plain DOM only.

interface LlamaProps {
  model_path?: string;
  total_slots?: number;
  n_ctx?: number;
}

interface SlotNextToken {
  has_next_token?: boolean;
  has_new_line?: boolean;
  n_remain?: number;
  n_decoded?: number;
}

interface LlamaSlot {
  id?: number;
  n_ctx?: number;
  speculative?: boolean;
  is_processing?: boolean;
  id_task?: number;
  n_prompt_tokens?: number;
  n_prompt_tokens_processed?: number;
  n_prompt_tokens_cache?: number;
  next_token?: SlotNextToken[] | SlotNextToken;
  prompt?: string;
  generated?: string;
}

interface Metrics {
  perPos: { [position: number]: number };
  predicted_tokens_seconds?: number;
  tokens_predicted_total?: number;
  tokens_predicted_seconds_total?: number;
  prompt_tokens_seconds?: number;
  prompt_tokens_total?: number;
  prompt_seconds_total?: number;
  prompt_tokens_cached_total?: number;
  requests_processing?: number;
  requests_deferred?: number;
  n_decode_total?: number;
  n_busy_slots_per_decode?: number;
  n_tokens_max?: number;
  spec_decode_num_draft_tokens_total?: number;
  spec_decode_num_accepted_tokens_total?: number;
  spec_decode_num_drafts_total?: number;
}

interface GpuDevice {
  bdf: string;
  name: string;
  vram_resident_gib?: number | null;
  vram_total_gib?: number | null;
  vram_pct?: number | null;
  busy_ccs_pct?: number | null;
  busy_bcs_pct?: number | null;
  freq_act_mhz?: number | null;
  freq_cur_mhz?: number | null;
  freq_max_mhz?: number | null;
}

interface GpuSnapshot {
  devices?: GpuDevice[];
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const POLL_MS = 2000;
const HISTORY_MAX = 90;

// The monitor is served by xellama-gpu-telemetry from the same origin
// that proxies llama-server, so every API path is relative to this
// page. No server-URL form, no persisted base, no origin to compute.
const base = "";

const decodeHistory: number[] = [];
let timer: number | undefined = undefined;
let gpuTimer: number | undefined = undefined;
// scroll state per pane, keyed "p<slotId>" / "g<slotId>"
const lastSlotsScroll: { [key: string]: { top: number; atBottom: boolean } } = {};

function esc(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("ja-JP");
}

function fmtFloat(n: number | null | undefined, digits?: number): string {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(digits == null ? 2 : digits);
}

function basename(p: string | null | undefined): string {
  if (!p) return "—";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

/* ---------- Prometheus parsing ---------- */

function parseMetrics(text: string): Metrics {
  const out: Metrics = { perPos: {} };
  const bag = out as unknown as { [name: string]: number };
  const lines = String(text || "").split("\n");
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.charAt(0) === "#") continue;
    // llamacpp:<name>{labels} <value>  OR  llamacpp:<name> <value>
    const m = line.match(/^llamacpp:([a-zA-Z0-9_]+)(\{([^}]*)\})?\s+(-?[0-9.eE+-]+)\s*$/);
    if (!m) continue;
    const name = m[1];
    const labels = m[3] || "";
    const value = parseFloat(m[4]);
    if (isNaN(value)) continue;
    if (name === "spec_decode_num_accepted_tokens_per_pos_total") {
      const pm = labels.match(/position\s*=\s*"(\d+)"/);
      if (pm) out.perPos[parseInt(pm[1], 10)] = value;
      continue;
    }
    bag[name] = value;
  }
  return out;
}

/* ---------- Fetch helpers ---------- */

function fetchText(url: string): Promise<string> {
  return fetch(url, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json() as Promise<T>;
  });
}

function settled<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (v) => ({ ok: true, value: v } as Settled<T>),
    (e) => ({ ok: false, error: e } as Settled<T>)
  );
}

/* ---------- Sparkline ---------- */

function drawSpark(): void {
  const canvas = $("spark") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 260;
  const cssH = 52;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  // baseline grid
  ctx.strokeStyle = "#262b33";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cssH - 0.5);
  ctx.lineTo(cssW, cssH - 0.5);
  ctx.stroke();
  if (decodeHistory.length < 2) {
    ctx.fillStyle = "#6b7480";
    ctx.font = "11px sans-serif";
    ctx.fillText(decodeHistory.length === 1 ? "サンプリング中…" : "データ待ち", 2, 16);
    return;
  }
  let max = 0;
  let min = Infinity;
  for (const v of decodeHistory) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (max === min) { max += 1; min = Math.max(0, min - 1); }
  const padTop = 4;
  const padBot = 4;
  const h = cssH - padTop - padBot;
  const X = (idx: number): number => (decodeHistory.length <= 1 ? 0 : (idx / (HISTORY_MAX - 1)) * cssW);
  const Y = (v: number): number => padTop + (1 - (v - min) / (max - min)) * h;
  // line + fill
  ctx.beginPath();
  decodeHistory.forEach((v, j) => {
    const x = X(j);
    const y = Y(v);
    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#2dd4bf";
  ctx.lineWidth = 1.8;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineTo(X(decodeHistory.length - 1), cssH);
  ctx.lineTo(X(0), cssH);
  ctx.closePath();
  ctx.fillStyle = "rgba(45,212,191,0.12)";
  ctx.fill();
  // last point
  const lx = X(decodeHistory.length - 1);
  const ly = Y(decodeHistory[decodeHistory.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = "#2dd4bf";
  ctx.fill();
  // max label
  ctx.fillStyle = "#6b7480";
  ctx.font = "10px sans-serif";
  ctx.fillText(fmtFloat(max, 1), 2, 11);
}

/* ---------- Slots helpers ---------- */

function slotNext(slot: LlamaSlot | null | undefined): SlotNextToken | null {
  const nt = slot ? slot.next_token : undefined;
  if (Array.isArray(nt) && nt.length && nt[0]) return nt[0];
  if (nt && typeof nt === "object" && !Array.isArray(nt)) return nt as SlotNextToken;
  return null;
}

function slotDecoded(slot: LlamaSlot | null | undefined): number {
  const nt = slotNext(slot);
  return nt && nt.n_decoded ? nt.n_decoded : 0;
}

function slotRemain(slot: LlamaSlot | null | undefined): number | null {
  const nt = slotNext(slot);
  return nt && nt.n_remain != null ? nt.n_remain : null;
}

function slotUsed(slot: LlamaSlot | null | undefined): number {
  return (slot && slot.n_prompt_tokens_processed ? slot.n_prompt_tokens_processed : 0) + slotDecoded(slot);
}

function renderSlots(slots: LlamaSlot[], slotsOk: boolean): void {
  const panel = $("slotsPanel");
  // remember scroll positions of existing panes
  const pres = panel.querySelectorAll<HTMLPreElement>("pre[data-scroll-key]");
  pres.forEach((pre) => {
    const key = pre.getAttribute("data-scroll-key") as string;
    lastSlotsScroll[key] = {
      top: pre.scrollTop,
      atBottom: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8,
    };
  });
  if (!slotsOk) {
    panel.innerHTML = '<div class="unavail">スロット情報を取得できませんでした（/slots）。上のカードは /metrics と /props から表示しています。</div>';
    return;
  }
  if (!Array.isArray(slots) || slots.length === 0) {
    panel.innerHTML = '<div class="unavail">スロットがありません。</div>';
    return;
  }
  let html = "";
  slots.forEach((slot, idx) => {
    const id: number | string = slot && slot.id != null ? slot.id : idx;
    const nCtx = (slot && slot.n_ctx) || 0;
    const used = slotUsed(slot);
    const pct = nCtx > 0 ? Math.min(100, (used / nCtx) * 100) : 0;
    const processing = !!(slot && slot.is_processing);
    const taskId: number | string = slot && slot.id_task != null && slot.id_task !== -1 ? slot.id_task : "—";
    const promptTotal = slot && slot.n_prompt_tokens != null ? slot.n_prompt_tokens : null;
    const promptProc = slot && slot.n_prompt_tokens_processed != null ? slot.n_prompt_tokens_processed : null;
    const cached = slot && slot.n_prompt_tokens_cache != null ? slot.n_prompt_tokens_cache : null;
    const decoded = slotDecoded(slot);
    const remain = slotRemain(slot);
    const promptText = slot && typeof slot.prompt === "string" ? slot.prompt : "";
    const genText = slot && typeof slot.generated === "string" ? slot.generated : "";
    const meterCls = pct >= 90 ? "meter hot" : pct >= 70 ? "meter warn" : "meter";

    html += '<article class="slot">';
    html += '<div class="slot-head">';
    html += '<span class="sid">Slot ' + esc(id) + "</span>";
    html += '<span class="tid">task ' + esc(taskId) + "</span>";
    if (slot && slot.speculative) html += '<span class="badge spec">SPECULATIVE</span>';
    html += processing ? '<span class="badge proc">処理中</span>' : '<span class="badge idle">待機中</span>';
    html += '<span class="tid" style="margin-left:auto">' + fmtNum(used) + " / " + (nCtx ? fmtNum(nCtx) : "—") + " tok（" + fmtFloat(pct, 1) + "%）</span>";
    html += "</div>";
    html += '<div class="' + meterCls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
    html += '<div class="facts">';
    html += '<div class="fact"><div class="k">プロンプト処理</div><div class="v">' + (promptProc == null ? "—" : fmtNum(promptProc)) + " <small>/ " + (promptTotal == null ? "—" : fmtNum(promptTotal)) + "</small></div></div>";
    html += '<div class="fact"><div class="k">キャッシュ済み</div><div class="v">' + (cached == null ? "—" : fmtNum(cached)) + "</div></div>";
    html += '<div class="fact"><div class="k">生成済み</div><div class="v">' + fmtNum(decoded) + "</div></div>";
    html += '<div class="fact"><div class="k">残り</div><div class="v">' + (remain == null ? "—" : fmtNum(remain)) + "</div></div>";
    html += "</div>";
    html += '<div class="panes">';
    html += '<div class="pane"><div class="pane-head"><span>Prompt</span><span>' + fmtNum(promptText.length) + " 文字</span></div>";
    html += '<pre data-scroll-key="p' + esc(id) + '">' + (promptText ? esc(promptText) : '<span class="none">（なし）</span>') + "</pre></div>";
    html += '<div class="pane"><div class="pane-head"><span>Generated</span><span>' + fmtNum(genText.length) + " 文字</span></div>";
    html += '<pre class="gen" data-scroll-key="g' + esc(id) + '">' + (genText ? esc(genText) : '<span class="none">（まだ生成されていません）</span>') + "</pre></div>";
    html += "</div></article>";
  });
  panel.innerHTML = html;
  // restore scroll (follow bottom for generated if it was at bottom)
  const news = panel.querySelectorAll<HTMLPreElement>("pre[data-scroll-key]");
  news.forEach((pre) => {
    const skey = pre.getAttribute("data-scroll-key") as string;
    const prev = lastSlotsScroll[skey];
    if (prev) {
      if (prev.atBottom) pre.scrollTop = pre.scrollHeight;
      else pre.scrollTop = prev.top;
    } else if (skey.charAt(0) === "g") {
      pre.scrollTop = pre.scrollHeight;
    }
  });
}

/* ---------- Main render ---------- */

function render(propsRes: Settled<LlamaProps>, metricsRes: Settled<Metrics>, slotsRes: Settled<LlamaSlot[]>): void {
  const propsOk = propsRes.ok;
  const metricsOk = metricsRes.ok;
  const slotsOk = slotsRes.ok;
  const connected = propsOk || metricsOk;
  const props: LlamaProps = propsRes.ok ? propsRes.value || {} : {};
  const m: Metrics = metricsRes.ok ? metricsRes.value : { perPos: {} };
  const slots: LlamaSlot[] = slotsRes.ok && Array.isArray(slotsRes.value) ? slotsRes.value : [];

  // connection status
  const anyProcessing = (m.requests_processing || 0) > 0 || slots.some((s) => !!(s && s.is_processing));
  const dot = $("connDot");
  const ctext = $("connText");
  const mdot = $("modelDot");
  if (!connected) {
    dot.className = "dot down";
    mdot.className = "dot down";
    ctext.textContent = "未接続";
    $("modelState").textContent = "Disconnected";
    $("downNotice").className = "notice show";
  } else {
    dot.className = "dot " + (anyProcessing ? "busy" : "live");
    mdot.className = "dot " + (anyProcessing ? "busy" : "live");
    ctext.textContent = anyProcessing ? "ライブ · 処理中" : "ライブ";
    $("modelState").textContent = anyProcessing ? "In use" : "Loaded";
    $("downNotice").className = "notice";
  }

  // Model card
  if (propsOk) {
    $("modelName").textContent = basename(props.model_path);
    const totalSlots = props.total_slots != null ? props.total_slots : slots.length || null;
    $("modelMeta").textContent = "スロット " + (totalSlots == null ? "—" : totalSlots) + " · コンテキスト " + (props.n_ctx != null ? fmtNum(props.n_ctx) : "—");
  } else if (!connected) {
    $("modelName").textContent = "—";
    $("modelMeta").textContent = "スロット — · コンテキスト —";
  }
  $("modelReq").innerHTML = "処理中 <b>" + (metricsOk ? fmtNum(m.requests_processing || 0) : "—") + "</b> · 保留 <b>" + (metricsOk ? fmtNum(m.requests_deferred || 0) : "—") + "</b>";

  // Decode card
  if (metricsOk) {
    const dSpeed = m.predicted_tokens_seconds;
    if (m.tokens_predicted_seconds_total && m.tokens_predicted_total) {
      $("decodeSpeed").textContent = fmtFloat(m.tokens_predicted_total / m.tokens_predicted_seconds_total, 2);
    } else {
      $("decodeSpeed").textContent = "—";
    }
    $("decodeTotal").textContent = fmtNum(m.tokens_predicted_total);
    $("decodeAvg").textContent = "瞬間 " + (dSpeed == null ? "—" : fmtFloat(dSpeed, 2) + " tok/s");
    if (dSpeed != null && !isNaN(dSpeed)) {
      decodeHistory.push(dSpeed);
      if (decodeHistory.length > HISTORY_MAX) decodeHistory.shift();
    }
  }
  drawSpark();

  // Prompt card
  if (metricsOk) {
    if (m.prompt_seconds_total && m.prompt_tokens_total) {
      $("promptSpeed").textContent = fmtFloat(m.prompt_tokens_total / m.prompt_seconds_total, 1);
    } else {
      $("promptSpeed").textContent = "—";
    }
    $("promptTotal").textContent = fmtNum(m.prompt_tokens_total);
    $("promptCached").textContent = fmtNum(m.prompt_tokens_cached_total);
    if (m.prompt_tokens_total) {
      $("promptCacheRate").textContent = "キャッシュ率 " + fmtFloat(((m.prompt_tokens_cached_total || 0) / m.prompt_tokens_total) * 100, 1) + " %";
    } else {
      $("promptCacheRate").textContent = "キャッシュ率 —";
    }
  }

  // Speculative card
  const draftTotal = m.spec_decode_num_draft_tokens_total;
  const acceptedTotal = m.spec_decode_num_accepted_tokens_total;
  const draftsTotal = m.spec_decode_num_drafts_total;
  if (metricsOk && draftTotal) {
    const rate = acceptedTotal != null ? (acceptedTotal / draftTotal) * 100 : null;
    $("specRate").textContent = rate == null ? "—" : fmtFloat(rate, 1);
    $("specUnit").textContent = rate == null ? "" : "% 受理";
    $("specSub").innerHTML = "受理 <b>" + fmtNum(acceptedTotal) + "</b> / ドラフト <b>" + fmtNum(draftTotal) + "</b> トークン · 検証ステップ <b>" + fmtNum(draftsTotal) + "</b>";
    // per-position bars
    const positions = Object.keys(m.perPos || {}).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
    if (positions.length && draftsTotal) {
      let bhtml = "";
      positions.forEach((p) => {
        const r = m.perPos[p] / draftsTotal;
        const pctv = Math.max(0, Math.min(100, r * 100));
        bhtml += '<div class="bar-col"><span class="bar-val">' + fmtFloat(pctv, 0) + '%</span><div class="bar-track"><div class="bar-fill" style="height:' + Math.max(4, pctv) + '%"></div></div><span class="bar-lab">P' + p + "</span></div>";
      });
      $("specBars").innerHTML = bhtml;
    } else {
      $("specBars").innerHTML = '<div class="empty-note">位置別データなし</div>';
    }
  } else if (metricsOk) {
    $("specRate").textContent = "—";
    $("specUnit").textContent = "";
    $("specBars").innerHTML = '<div class="empty-note">投機リクエストはまだありません</div>';
    $("specSub").textContent = "no speculative requests yet";
  }

  // Context card
  const ctxN = props.n_ctx != null ? props.n_ctx : null;
  let maxUsed = 0;
  let maxSlotId: number | string | null = null;
  let hasSlotCtx = false;
  slots.forEach((s, i) => {
    if (!s) return;
    const sc = s.n_ctx || ctxN;
    if (!sc) return;
    hasSlotCtx = true;
    const u = slotUsed(s);
    if (maxSlotId === null || u > maxUsed) {
      maxUsed = u;
      maxSlotId = s.id != null ? s.id : i;
    }
  });
  if (slotsOk && hasSlotCtx) {
    const found = slots.filter((s) => s && s.id == maxSlotId)[0];
    const denomCtx = (found && found.n_ctx) || ctxN || 0;
    const pct2 = denomCtx ? Math.min(100, (maxUsed / denomCtx) * 100) : 0;
    $("ctxPct").textContent = fmtFloat(pct2, 1);
    const meter = $("ctxMeter");
    meter.className = pct2 >= 90 ? "meter hot" : pct2 >= 70 ? "meter warn" : "meter";
    (meter.firstElementChild as HTMLElement).style.width = pct2.toFixed(1) + "%";
    $("ctxDetail").textContent = "Slot " + maxSlotId + " · " + fmtNum(maxUsed) + " / " + fmtNum(denomCtx) + " tok";
  } else {
    $("ctxPct").textContent = "—";
    ($("ctxMeter").firstElementChild as HTMLElement).style.width = "0%";
    $("ctxDetail").textContent = slotsOk ? "スロット情報なし" : "スロット取得不可";
  }
  if (metricsOk) $("ctxMax").textContent = fmtNum(m.n_tokens_max);

  // Slots panel
  renderSlots(slots, slotsOk);

  // Footer
  if (metricsOk) {
    $("footDecode").textContent = fmtNum(m.n_decode_total);
    $("footBusy").textContent = m.n_busy_slots_per_decode == null ? "—" : fmtFloat(m.n_busy_slots_per_decode, 3);
  }
  if (connected) {
    $("footUpdated").textContent = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  }
}

/* ---------- Polling ---------- */

function poll(): void {
  const b = base;
  const p1 = settled(fetchJson<LlamaProps>(b + "/props"));
  const p2 = settled(fetchText(b + "/metrics").then(parseMetrics));
  const p3 = settled(fetchJson<LlamaSlot[]>(b + "/slots"));
  Promise.all([p1, p2, p3]).then((res) => {
    // base is fixed to this origin; kept as a cheap in-flight guard
    if (b !== base) return;
    render(res[0], res[1], res[2]);
  });
}

function startPolling(): void {
  if (timer !== undefined) window.clearInterval(timer);
  poll();
  timer = window.setInterval(poll, POLL_MS);
  if (gpuTimer !== undefined) window.clearInterval(gpuTimer);
  pollGpu();
  gpuTimer = window.setInterval(pollGpu, POLL_MS);
}

/* ---------- GPU telemetry (same-origin /gpu.json) ---------- */

function gpuCardHtml(d: GpuDevice): string {
  const pct = d.vram_pct == null ? 0 : Math.max(0, Math.min(100, d.vram_pct));
  const freq = d.freq_act_mhz != null ? d.freq_act_mhz : d.freq_cur_mhz;
  let h = "<article class=\"card\">";
  h += "<div class=\"label\"><span>" + esc(d.name || d.bdf) + "</span><span>GPU</span></div>";
  h += "<div class=\"big\">" + fmtFloat(d.vram_resident_gib, 1) + "<span class=\"unit\">GiB</span></div>";
  h += "<div class=\"meter\"><i style=\"width:" + pct.toFixed(1) + "%\"></i></div>";
  h += "<div class=\"subline\">VRAM 合計 <b>" + fmtFloat(d.vram_total_gib, 2) + " GiB</b> · 使用率 <b>" + fmtFloat(d.vram_pct, 1) + "%</b></div>";
  h += "<div class=\"subline\">計算 CCS <b>" + fmtFloat(d.busy_ccs_pct, 0) + "%</b> · コピー BCS <b>" + fmtFloat(d.busy_bcs_pct, 0) + "%</b></div>";
  if (freq != null || d.freq_max_mhz != null) {
    h += "<div class=\"subline\">周波数 <b>" + fmtNum(freq) + "</b> / " + fmtNum(d.freq_max_mhz) + " MHz</div>";
  }
  h += "</article>";
  return h;
}

function renderGpu(res: Settled<GpuSnapshot>): void {
  const el = $("gpuCards");
  if (!res.ok || !res.value.devices || res.value.devices.length === 0) {
    el.innerHTML = "<article class=\"card\"><div class=\"label\"><span>GPU</span><span>TELEMETRY</span></div>" +
      "<div class=\"big\">—</div><div class=\"subline\">GPU テレメトリ取得不可（/gpu.json）</div></article>";
    return;
  }
  el.innerHTML = res.value.devices.map(gpuCardHtml).join("");
}

function pollGpu(): void {
  settled(fetchJson<GpuSnapshot>(base + "/gpu.json")).then(renderGpu);
}

window.addEventListener("resize", drawSpark);
startPolling();
