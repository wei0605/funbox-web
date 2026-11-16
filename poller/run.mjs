// 在「您家裡的電腦」執行的偵測 + 下單程式:抓 Funbox 網頁 → 回報給 Cloudflare Worker(大腦)→ 依指示自動下單。
//
// 設定放在 poller/local.env(不會上傳到 GitHub),範本見 poller/local.env.example:
//   WORKER_URL      Worker 網址
//   POLLER_TOKEN    與 Worker 的 POLLER_TOKEN 相同
//   DISCORD_WEBHOOK (選填)傳下單截圖用
//   CHROME_PROFILE  FunboxSniper 專屬 Chrome 的設定檔資料夾(登入狀態在這裡)
//   CARD_FILE       FunboxSniper 存的 card.dat(加密信用卡)
//   BUY_ENABLED     0 = 不啟動下單程式,只偵測
//
// 用法:
//   start-monitor.bat                       持續監控(關閉視窗即停止)
//   node poller/run.mjs --test-buy bb09728  對有貨商品演練下單(走到結帳頁就停,絕不送出)
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fetchProduct, fetchText, extractSlugs, looksBlocked } from "../src/parse.js";
import { Buyer, sendDiscordFile } from "./checkout.mjs";

// 讀 poller/local.env(已經有的環境變數優先)
const ENV_FILE = new URL("./local.env", import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

const WORKER = (process.env.WORKER_URL || "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.POLLER_TOKEN || "").trim();
const RUN_MS = Number(process.env.RUN_MINUTES) > 0 ? Number(process.env.RUN_MINUTES) * 60_000 : Infinity; // 預設一直跑
const HOOK = (process.env.DISCORD_WEBHOOK || "").trim();
const RUNNER = `電腦 ${os.hostname()}`;
const TEST_SLUG = (() => {
  const i = process.argv.indexOf("--test-buy");
  return i > 0 ? String(process.argv[i + 1] || "").trim().toLowerCase() : "";
})();

const buyerOptions = (base) => ({
  base,
  hook: HOOK,
  log,
  port: process.env.CHROME_PORT || 9222,
  profile: process.env.CHROME_PROFILE,
  chromePath: process.env.CHROME_PATH,
  cardFile: process.env.CARD_FILE,
});
const HEARTBEAT_MS = 20_000;
const KEEPALIVE_MS = 10 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
const log = (...a) => console.log(ts(), ...a);

function absUrl(base, u) {
  return u.startsWith("http") ? u : base.replace(/\/+$/, "") + u;
}

async function scanSource(base, src) {
  const t0 = Date.now();
  try {
    const { resp, text } = await fetchText(absUrl(base, src.url), 10_000);
    const blocked = resp.ok && looksBlocked(resp, text);
    if (!resp.ok || blocked) {
      return { name: src.name, ok: false, status: resp.status, ms: Date.now() - t0, error: blocked ? "被 Cloudflare 驗證頁擋下" : `HTTP ${resp.status}` };
    }
    return { name: src.name, ok: true, status: resp.status, ms: Date.now() - t0, slugs: [...extractSlugs(text)] };
  } catch (e) {
    return { name: src.name, ok: false, ms: Date.now() - t0, error: e.name === "TimeoutError" ? "連線逾時" : String(e.message || e) };
  }
}

async function checkProduct(base, slug, first) {
  try {
    const p = await fetchProduct(base, slug);
    return { slug, first, ok: true, product: { name: p.name, price: p.price, variantId: p.variantId, exists: p.exists, inStock: p.inStock } };
  } catch (e) {
    return { slug, first, ok: false, error: e.name === "TimeoutError" ? "連線逾時" : String(e.message || e) };
  }
}

async function report(payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(WORKER + "/api/report", {
        method: "POST",
        headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Worker 拒絕(HTTP ${r.status}):POLLER_TOKEN 不正確`), { fatal: true });
      if (!r.ok) throw new Error(`Worker HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.fatal) throw e;
      log("回報失敗:", e.message);
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ------------------------------------------------------------------ 演練模式(單一商品)
async function testBuy(slug) {
  if (!slug) throw new Error("用法:node poller/run.mjs --test-buy 商品代碼");
  const base = process.env.BASE_URL || "https://shop.funbox.com.tw";
  const p = await fetchProduct(base, slug);
  log(`商品 ${slug}:${p.name || ""} ${p.exists ? (p.inStock ? "有貨" : "缺貨") : "頁面不存在"}`);
  if (!p.exists || !p.variantId) throw new Error("找不到商品或規格(variant_id)");
  const buyer = new Buyer(buyerOptions(base));
  await buyer.start();
  log("登入狀態:", buyer.status().msg);
  const r = await buyer.buy({
    slug, variantId: p.variantId, name: p.name, qty: 1, live: false,
    payment_keyword: process.env.PAYMENT_KEYWORD ?? "信用卡", shipping_keyword: process.env.SHIPPING_KEYWORD || "",
  });
  log("結果:", r.ok ? "成功" : "失敗", r.message);
  await buyer.close();
  if (!r.ok) process.exitCode = 1;
}

// ------------------------------------------------------------------ 主迴圈
async function main() {
  if (!WORKER || !TOKEN) throw new Error("請設定 WORKER_URL 與 POLLER_TOKEN");
  const deadline = Date.now() + RUN_MS;
  log(`啟動(${RUNNER})`);

  let buyer = null;
  const notices = [];
  const buyerStatus = () => (buyer ? buyer.status() : { ok: false, msg: "下單程式未啟用(BUY_ENABLED=0)" });

  let plan = await report({ runner: RUNNER, buyer: buyerStatus() });
  if (!plan) throw new Error("連不上 Worker,請確認 WORKER_URL");

  if (process.env.BUY_ENABLED !== "0") {
    buyer = new Buyer(buyerOptions(plan.config.base_url));
    try {
      await buyer.start();
      log("下單程式:", buyer.status().msg);
      if (!buyer.status().ok) notices.push(buyer.status().msg);
    } catch (e) {
      log("下單程式啟動失敗:", e.message);
      notices.push(`下單程式啟動失敗:${e.message}`);
    }
    plan = (await report({ runner: RUNNER, buyer: buyerStatus(), notices: notices.splice(0) })) || plan;
  }
  log(plan.enabled ? "控制台狀態:監控中" : "控制台狀態:已停止(等待在手機按「開始監控」)");

  const nextSrc = {};
  let nextPending = 0;
  let lastReport = Date.now();
  let lastKeepalive = Date.now();
  let wasEnabled = plan.enabled;

  while (Date.now() < deadline) {
    const now = Date.now();
    const payload = { runner: RUNNER, buyer: buyerStatus(), notices: notices.splice(0), sources: [], products: [], orders: [] };
    const base = plan.config.base_url;

    if (plan.enabled !== wasEnabled) {
      log(plan.enabled ? "▶ 控制台已開始監控" : "■ 控制台已停止監控");
      wasEnabled = plan.enabled;
    }

    if (plan.enabled) {
      const due = plan.config.sources.filter((s) => now >= (nextSrc[s.name] ?? 0));
      for (const s of due) nextSrc[s.name] = now + Math.max(3, s.interval) * 1000;
      const pend = plan.pending.length && now >= nextPending ? plan.pending : [];
      if (pend.length) nextPending = now + Math.max(2, plan.config.pending_interval) * 1000;
      const [srcRes, prodRes] = await Promise.all([
        Promise.all(due.map((s) => scanSource(base, s))),
        Promise.all(pend.map((s) => checkProduct(base, s, false))),
      ]);
      payload.sources = srcRes;
      payload.products = prodRes;
      for (const r of srcRes) if (!r.ok) log(`[${r.name}] ${r.error}`);
    }

    // 登入保持(每 10 分鐘)
    if (buyer?.ready && now - lastKeepalive > KEEPALIVE_MS) {
      lastKeepalive = now;
      const before = buyer.status().ok;
      await buyer.keepalive();
      if (before && !buyer.status().ok) payload.notices.push(buyer.status().msg);
    }

    const hasData = payload.sources.length || payload.products.length || payload.notices.length;
    if (!hasData && now - lastReport < HEARTBEAT_MS) {
      await sleep(plan.enabled ? 300 : 2000);
      continue;
    }

    // 回報;新網址要抓商品頁、有下單指示要下單,做完再回報一次(最多連續 3 輪)
    for (let round = 0; round < 3; round++) {
      const res = await report(payload);
      lastReport = Date.now();
      if (!res) break;
      plan = res;
      const follow = { runner: RUNNER, buyer: buyerStatus(), notices: [], products: [], orders: [] };
      if (plan.buys?.length) {
        for (const order of plan.buys) {
          log(`下單 ${order.slug}(${order.live ? "正式" : "演練"})`);
          const r = buyer ? await buyer.buy(order) : { slug: order.slug, ok: false, message: "下單程式未啟動" };
          log(`下單 ${order.slug} → ${r.ok ? "成功" : "失敗"}`);
          follow.orders.push(r);
        }
      }
      if (plan.need?.length) {
        log(`新商品網址 ${plan.need.length} 件:${plan.need.join(", ")}`);
        follow.products = await Promise.all(plan.need.map((s) => checkProduct(plan.config.base_url, s, true)));
      }
      if (!follow.orders.length && !follow.products.length) break;
      Object.assign(payload, follow, { sources: [] });
    }
  }

  log("達到設定的執行時間,結束");
  await buyer?.close();
}

const run = process.argv.includes("--test-buy") ? testBuy(TEST_SLUG) : main();
run.catch((e) => {
  console.error(ts(), "錯誤:", e.message);
  if (HOOK && !TEST_SLUG) {
    sendDiscordFile(HOOK, `**⚠ 電腦上的偵測程式停止**\n${e.message}`).catch(() => {});
  }
  process.exitCode = 1;
});
