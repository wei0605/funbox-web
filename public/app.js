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
  const STALE_MS = 15 * 60 * 1000;
  const stalled = st.enabled && st.now - st.lastIngestAt > STALE_MS;
  const pill = $("#pill");
  pill.textContent = stalled ? "等待輪詢" : st.enabled ? "監控中" : "已停止";
  pill.className = "pill " + (stalled ? "warn" : st.enabled ? "on" : "off");
  const tb = $("#toggleBtn");
  tb.textContent = st.enabled ? "■ 停止監控" : "▶ 開始監控";
  tb.className = "btn big " + (st.enabled ? "stop" : "start");

  // 警示
  let w = "";
  if (!st.hasWebhook) w += `<div class="banner bad">尚未設定 Discord Webhook,偵測到商品也不會通知。請在部署時設定 DISCORD_WEBHOOK。</div>`;
  if (stalled) {
    w += `<div class="banner">${
      st.lastIngestAt ? `已超過 ${Math.floor((st.now - st.lastIngestAt) / 60000)} 分鐘沒有收到輪詢回報` : "還沒收到輪詢程式的回報"
    }。請到 GitHub 專案的 Actions 頁面,確認 poll-funbox 有在執行。</div>`;
  }
  $("#warnings").innerHTML = w;

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

  // 追蹤清單
  $("#pending").innerHTML = st.pending.length
    ? st.pending
        .map(
          (p) => `<div class="card pend"><div>
            <a href="${esc(st.config.base_url)}/products/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">${esc(p.slug)}</a>
            <div class="muted small">${p.manual ? "手動追蹤 · " : ""}自 ${fmtTime(p.since)}</div></div>
            <button class="x" data-del="${esc(p.slug)}" aria-label="移除">✕</button></div>`,
        )
        .join("")
    : `<div class="muted small center">目前沒有追蹤中的商品</div>`;
  $("#meta").textContent = `已記錄 ${st.knownCount} 件既有商品 · 輪詢最近回報:${st.lastIngestAt ? ago(st.lastIngestAt, st.now) : "尚無"}`;

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
  };
}

// ------------------------------------------------------------------ 事件
$("#addSource").onclick = () => $("#f_sources").appendChild(sourceRow());

$("#settingsForm").onsubmit = (e) => {
  e.preventDefault();
  run($("#saveBtn"), async () => {
    const r = await api("/config", "PUT", readForm());
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
    toast(`已加入追蹤:${r.slug}`);
    await refresh();
  });
};

$("#pending").addEventListener("click", (e) => {
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
