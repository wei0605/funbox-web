"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let token = localStorage.getItem("fw_token") || "";
let state = null;
let formLoaded = false; // 設定表單只在第一次(或儲存後)載入,避免輪詢時蓋掉正在輸入的內容
let pollTimer = null;
let busy = false;

// ------------------------------------------------------------------ API
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, {
    method,
    headers: { Authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (r.status === 401) {
    showLogin("密碼錯誤或已失效");
    throw new Error("unauthorized");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { data });
  return data;
}

function toast(msg, bad = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 2800);
}

async function run(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ 登入
function showLogin(msg = "") {
  stopPolling();
  token = "";
  localStorage.removeItem("fw_token");
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#loginErr").textContent = msg;
}

$("#loginBtn").onclick = async () => {
  token = $("#tokenInput").value.trim();
  if (!token) return;
  try {
    state = await api("/state");
    localStorage.setItem("fw_token", token);
    $("#tokenInput").value = "";
    showApp();
  } catch (e) {
    if (e.message !== "unauthorized") $("#loginErr").textContent = e.message;
  }
};
$("#tokenInput").addEventListener("keydown", (e) => e.key === "Enter" && $("#loginBtn").click());

function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  formLoaded = false;
  render();
  startPolling();
}

// ------------------------------------------------------------------ 輪詢
async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    state = await api("/state");
    render();
  } catch {
    /* 網路暫時失敗就等下一輪 */
  } finally {
    busy = false;
  }
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, 3000);
}
function stopPolling() {
  clearInterval(pollTimer);
}
document.addEventListener("visibilitychange", () => !document.hidden && token && refresh());

// ------------------------------------------------------------------ 畫面
const fmtTime = (ms) =>
  new Date(ms).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function ago(ms, now) {
  if (!ms) return "尚未掃描";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  return `${Math.floor(s / 3600)} 小時前`;
}

function render() {
  if (!state) return;
  const st = state;

  // 狀態標籤與主按鈕
  const pl = st.poller;
  const isCron = !pl || pl.mode === "cron";
  const stalled = st.enabled && !st.pollerOnline;
  const pill = $("#pill");
  pill.textContent = stalled ? "等待排程" : st.enabled ? "監控中" : "已停止";
  pill.className = "pill " + (stalled ? "warn" : st.enabled ? "on" : "off");
  const tb = $("#toggleBtn");
  tb.textContent = st.enabled ? "■ 停止監控" : "▶ 開始監控";
  tb.className = "btn big " + (st.enabled ? "stop" : "start");

  // 警示
  let w = "";
  if (!st.hasWebhook) w += `<div class="banner bad">尚未設定 Discord Webhook,偵測到商品也不會通知。請在部署時設定 DISCORD_WEBHOOK。</div>`;
  if (!st.hasPollerToken) w += `<div class="banner bad">尚未設定 POLLER_TOKEN,偵測程式無法回報。</div>`;
  if (stalled) {
    w += isCron
      ? `<div class="banner">等待 GitHub Actions 排程回報(約每 5～15 分鐘自動掃描一次;也可到 GitHub → Actions 點 Run workflow 立即測試)。</div>`
      : `<div class="banner">目前超過 90 秒未收到回報。若已關掉家裡電腦,下次 GitHub Actions 排程執行後會自動接手。</div>`;
  }
  if (st.config.buy.enabled && st.config.buy.live) w += `<div class="banner bad">本機自動下單:正式送出模式</div>`;
  $("#warnings").innerHTML = w;

  // 偵測引擎
  const buy = st.config.buy;
  const runnerTitle = pl
    ? `${esc(pl.runner)} · ${st.pollerOnline ? "運作正常" : "等待下次執行"}`
    : "尚未收到回報";
  const modeInfo = isCron
    ? "模式:雲端排程(每 5～15 分鐘自動掃描,電腦不用開機)"
    : !buy.enabled
      ? "模式:本機常駐(僅通知,自動下單關閉)"
      : pl?.buyer
        ? `本機自動下單:就緒(${buy.live ? "正式" : "演練"},關鍵字 ${buy.keywords.length ? esc(buy.keywords.join("、")) : "未設定"})`
        : `本機自動下單:未就緒${pl?.buyerMsg ? " · " + esc(pl.buyerMsg) : ""}`;
  $("#poller").innerHTML = `<div class="card src"><span class="dot ${st.pollerOnline ? "ok" : "bad"}"></span>
    <div><div class="name">${runnerTitle}</div>
    <div class="info">${pl ? `最後掃描 ${ago(pl.at, st.now)}` : "從未回報"}</div>
    <div class="info">${modeInfo}</div></div></div>`;

  // 下單紀錄
  const stateText = { sent: "處理中", ok: "✅ 已下單", dry: "🧪 演練完成", fail: "❌ 失敗" };
  $("#orders").innerHTML = st.orders.items.length
    ? st.orders.items
        .map(
          (o) => `<div class="card"><div class="name">${esc(o.name || o.slug)}</div>
            <div class="muted small">${stateText[o.state] || esc(o.state)} · ${fmtTime(o.t)}${o.message ? " · " + esc(o.message) : ""}</div></div>`,
        )
        .join("")
    : `<div class="muted small center">還沒有下單紀錄(正式下單 ${st.orders.count} 張)</div>`;

  // 來源
  $("#sources").innerHTML = st.sources
    .map((s) => {
      const bad = s.ok === false;
      const info = bad
        ? `⚠ ${esc(s.error)}`
        : s.ok
          ? `${s.count} 件商品 · ${s.ms}ms · ${ago(s.at, st.now)} · 掃描 ${s.scans} 次`
          : st.enabled ? "等待第一次掃描…" : "尚未啟動";
      return `<div class="card src"><span class="dot ${bad ? "bad" : s.ok ? "ok" : ""}"></span>
        <div><div class="name">${esc(s.name)}</div><div class="info ${bad ? "bad" : ""}">${info}</div></div></div>`;
    })
    .join("");

  // 關鍵字與追蹤清單
  const watchKws = st.watchKeywords || [];
  const buyKws = (st.config.buy?.keywords || []).filter(
    (bk) => !watchKws.some((wk) => wk.toLowerCase() === bk.toLowerCase()),
  );
  const kwCards = [
    ...watchKws.map(
      (kw) => `<div class="card pend"><div>
        <div class="name">🎯 標題關鍵字:${esc(kw)}</div>
        <div class="muted small">每次掃描全站搜尋標題(既有與新商品皆會比對)</div></div>
        <button class="x" data-del-kw="${esc(kw)}" aria-label="移除">✕</button></div>`,
    ),
    ...buyKws.map(
      (kw) => `<div class="card pend"><div>
        <div class="name">🎯 標題關鍵字:${esc(kw)}</div>
        <div class="muted small">來自「設定 → 下單關鍵字」(全站搜尋標題)</div></div></div>`,
    ),
  ];
  const pendCards = st.pending.map(
    (p) => `<div class="card pend"><div>
      <a href="${esc(st.config.base_url)}/products/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">${esc(p.slug)}</a>
      <div class="muted small">${p.manual ? "指定追蹤 · " : "等補貨 · "}自 ${fmtTime(p.since)}</div></div>
      <button class="x" data-del="${esc(p.slug)}" aria-label="移除">✕</button></div>`,
  );
  const allTrack = [...kwCards, ...pendCards];
  $("#pending").innerHTML = allTrack.length
    ? allTrack.join("")
    : `<div class="muted small center">目前沒有關鍵字或追蹤中的商品</div>`;
  $("#meta").textContent = `已記錄 ${st.knownCount} 件既有商品`;

  // 日誌
  $("#logs").innerHTML = st.logs.length
    ? [...st.logs]
        .reverse()
        .map((l) => `<div class="log ${esc(l.l)}"><span class="t">${fmtTime(l.t)}</span>${esc(l.m)}</div>`)
        .join("")
    : `<div class="muted small center">還沒有紀錄</div>`;

  if (!formLoaded) loadForm(st.config);
}

// ------------------------------------------------------------------ 設定表單
const list = (s) => s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);

function sourceRow(s = { name: "", url: "", interval: 10 }) {
  const d = document.createElement("div");
  d.className = "srcrow";
  d.innerHTML = `
    <label>名稱<input class="s_name" value="${esc(s.name)}" autocapitalize="off"></label>
    <label>間隔(秒)<input class="s_int" type="number" inputmode="numeric" min="3" value="${esc(s.interval)}"></label>
    <button type="button" class="x s_del" aria-label="刪除">✕</button>
    <label class="full">網址(/ 開頭的路徑或完整 https 網址)<input class="s_url" value="${esc(s.url)}" autocapitalize="off"></label>`;
  d.querySelector(".s_del").onclick = () => d.remove();
  return d;
}

function loadForm(c) {
  $("#f_base").value = c.base_url;
  const box = $("#f_sources");
  box.innerHTML = "";
  c.sources.forEach((s) => box.appendChild(sourceRow(s)));
  $("#f_prefix").value = c.match.slug_prefixes.join(", ");
  $("#f_include").value = c.match.include_keywords.join(", ");
  $("#f_exclude").value = c.match.exclude_keywords.join(", ");
  $("#f_pint").value = c.pending.interval;
  $("#f_ptimeout").value = c.pending.timeout_minutes;
  $("#f_mention").value = c.notify.mention;
  $("#f_cap").value = c.notify.max_unit_price;
  $("#f_cart").value = c.notify.cart_link_template;
  $("#f_qty").value = c.notify.cart_qty;
  $("#b_enabled").checked = c.buy.enabled;
  $("#b_live").checked = c.buy.live;
  $("#b_kw").value = c.buy.keywords.join(", ");
  $("#b_qty").value = c.buy.quantity;
  $("#b_max").value = c.buy.max_orders;
  $("#b_pay").value = c.buy.payment_keyword;
  $("#b_ship").value = c.buy.shipping_keyword;
  formLoaded = true;
}

function readForm() {
  return {
    base_url: $("#f_base").value.trim(),
    sources: [...document.querySelectorAll(".srcrow")].map((r) => ({
      name: r.querySelector(".s_name").value.trim(),
      url: r.querySelector(".s_url").value.trim(),
      interval: Number(r.querySelector(".s_int").value),
    })),
    match: {
      slug_prefixes: list($("#f_prefix").value),
      include_keywords: list($("#f_include").value),
      exclude_keywords: list($("#f_exclude").value),
    },
    pending: { interval: Number($("#f_pint").value), timeout_minutes: Number($("#f_ptimeout").value) },
    notify: {
      mention: $("#f_mention").value.trim(),
      max_unit_price: Number($("#f_cap").value) || 0,
      cart_link_template: $("#f_cart").value.trim(),
      cart_qty: Number($("#f_qty").value) || 1,
    },
    buy: {
      enabled: $("#b_enabled").checked,
      live: $("#b_live").checked,
      keywords: list($("#b_kw").value),
      quantity: Number($("#b_qty").value) || 1,
      max_orders: Number($("#b_max").value) || 1,
      payment_keyword: $("#b_pay").value.trim(),
      shipping_keyword: $("#b_ship").value.trim(),
    },
  };
}

// ------------------------------------------------------------------ 事件
$("#addSource").onclick = () => $("#f_sources").appendChild(sourceRow());

$("#settingsForm").onsubmit = (e) => {
  e.preventDefault();
  run($("#saveBtn"), async () => {
    const f = readForm();
    if (f.buy.enabled && f.buy.live && !state.config.buy.live &&
        !confirm("確定要開啟「正式送出訂單」?符合關鍵字的商品會真的下單。")) return;
    const r = await api("/config", "PUT", f);
    loadForm(r.config);
    toast("設定已儲存");
    await refresh();
  });
};

$("#toggleBtn").onclick = () =>
  run($("#toggleBtn"), async () => {
    await api(state.enabled ? "/stop" : "/start", "POST", {});
    await refresh();
  });

$("#watchForm").onsubmit = (e) => {
  e.preventDefault();
  const input = $("#watchInput").value.trim();
  if (!input) return;
  run(e.submitter || $("#watchForm button"), async () => {
    const r = await api("/watch", "POST", { input });
    $("#watchInput").value = "";
    toast(r.kind === "keyword" ? `已加入關鍵字「${r.value}」,下次掃描全站比對標題` : `已加入商品追蹤:${r.value},下次掃描檢查`);
    await refresh();
  });
};

$("#pending").addEventListener("click", (e) => {
  const kw = e.target.dataset?.delKw;
  if (kw !== undefined) {
    return run(e.target, async () => {
      await api("/watch-keyword/" + encodeURIComponent(kw), "DELETE");
      await refresh();
    });
  }
  const slug = e.target.dataset?.del;
  if (!slug) return;
  run(e.target, async () => {
    await api("/pending/" + encodeURIComponent(slug), "DELETE");
    await refresh();
  });
});

$("#testDiscord").onclick = () =>
  run($("#testDiscord"), async () => {
    await api("/test-discord", "POST", {});
    toast("測試通知已送出,請查看 Discord");
  });

$("#resetOrders").onclick = () =>
  run($("#resetOrders"), async () => {
    if (!confirm("清除下單紀錄後,已下單過的商品也可能再次下單。確定?")) return;
    await api("/reset-orders", "POST", {});
    toast("已清除下單紀錄");
    await refresh();
  });

$("#resetBtn").onclick = () =>
  run($("#resetBtn"), async () => {
    if (!confirm("清除已知商品後,下次掃描會把目前所有商品當作既有商品(不通知)。確定?")) return;
    await api("/reset", "POST", {});
    toast("已重設基準");
    await refresh();
  });

$("#clearLogs").onclick = () =>
  run($("#clearLogs"), async () => {
    await api("/clear-logs", "POST", {});
    await refresh();
  });

$("#logoutBtn").onclick = () => showLogin();

document.querySelector(".tabbar").addEventListener("click", (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b === e.target));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + tab));
  window.scrollTo(0, 0);
});

// ------------------------------------------------------------------ 啟動
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

(async () => {
  if (!token) return showLogin();
  try {
    state = await api("/state");
    showApp();
  } catch (e) {
    if (e.message !== "unauthorized") showLogin("無法連線,請稍後再試");
  }
})();
