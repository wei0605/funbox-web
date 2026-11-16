// 偵測程式:可跑在 GitHub Actions(--once 單次排程,免安裝套件)或家裡電腦(持續輪詢)。
// 負責抓 Funbox 網頁並透過 POST /api/report 回報給 Cloudflare Worker(大腦)判斷新品、補貨與通知。
//
// 環境變數(本機可放 poller/local.env;GitHub Actions 放 Repository Secrets):
//   WORKER_URL      Worker 網址
//   POLLER_TOKEN    與 Worker 的 POLLER_TOKEN(或 ADMIN_TOKEN)相同
//   BUY_ENABLED     0 = 只偵測不下單(GitHub Actions 固定為 0)
//
// 用法:
//   node poller/run.mjs --once              單次掃描(GitHub Actions 排程使用)
//   start-monitor.bat                       本機持續監控(選用)
//   node poller/run.mjs --test-buy bb09728  本機演練下單
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fetchProduct, fetchText, extractSlugs, looksBlocked } from "../src/parse.js";

// 讀 poller/local.env(已經有的環境變數優先)
const ENV_FILE = new URL("./local.env", import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  }
}

const IS_GHA = process.env.GITHUB_ACTIONS === "true";
const ONCE = process.argv.includes("--once") || process.env.ONCE === "1" || (IS_GHA && !process.env.RUN_MINUTES);
const WORKER = (process.env.WORKER_URL || "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.POLLER_TOKEN || process.env.ADMIN_TOKEN || "").trim();
const RUN_MS = Number(process.env.RUN_MINUTES) > 0 ? Number(process.env.RUN_MINUTES) * 60_000 : Infinity;
const HOOK = (process.env.DISCORD_WEBHOOK || "").trim();
const RUNNER = IS_GHA ? "GitHub Actions" : `電腦 ${os.hostname()}`;
const MODE = ONCE ? "cron" : "loop";
const BUY_ON = !ONCE && !IS_GHA && process.env.BUY_ENABLED !== "0";

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
    const { resp, text } = await fetchText(absUrl(base, src.url), 12_000);
    const blocked = resp.ok && looksBlocked(resp, text);
    if (!resp.ok || blocked) {
      return {
        name: src.name,
        ok: false,
        status: resp.status,
        ms: Date.now() - t0,
        error: blocked ? "被 Cloudflare 驗證頁擋下" : `HTTP ${resp.status}`,
      };
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
  const body = { runner: RUNNER, mode: MODE, ...payload };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(WORKER + "/api/report", {
        method: "POST",
        headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error(`Worker 拒絕(HTTP ${r.status}):請確認 GitHub Secrets 的 POLLER_TOKEN 是否正確`), { fatal: true });
      }
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

// ------------------------------------------------------------------ 單次掃描(GitHub Actions)
async function runOnce() {
  if (!WORKER || !TOKEN) {
    throw new Error("缺少 WORKER_URL 或 POLLER_TOKEN(請在 GitHub Settings → Secrets → Actions 新增 POLLER_TOKEN)");
  }
  const buyerInfo = { ok: false, msg: "雲端排程僅通知模式" };
  let plan = await report({ buyer: buyerInfo });
  if (!plan) throw new Error("連不上 Worker,請確認 WORKER_URL");

  if (!plan.enabled) {
    log("控制台目前為「已停止」,略過本輪掃描");
    return;
  }

  const base = plan.config.base_url;
  const [srcRes, prodRes] = await Promise.all([
    Promise.all(plan.config.sources.map((s) => scanSource(base, s))),
    Promise.all((plan.pending || []).map((s) => checkProduct(base, s, false))),
  ]);

  for (const r of srcRes) {
    if (r.ok) log(`[${r.name}] 讀到 ${r.slugs.length} 件商品 (${r.ms}ms)`);
    else log(`[${r.name}] 失敗:${r.error}`);
  }
  if (prodRes.length) log(`檢查追蹤清單 ${prodRes.length} 件商品`);

  let payload = { buyer: buyerInfo, sources: srcRes, products: prodRes };
  for (let round = 0; round < 3; round++) {
    const res = await report(payload);
    if (!res || !res.need?.length) break;
    log(`發現新商品網址 ${res.need.length} 件:${res.need.join(", ")},抓取商品頁…`);
    const followProducts = await Promise.all(res.need.map((s) => checkProduct(res.config.base_url, s, true)));
    payload = { buyer: buyerInfo, sources: [], products: followProducts };
  }
  log("本輪掃描完成");
}

// ------------------------------------------------------------------ 演練模式(本機單一商品)
async function testBuy(slug) {
  if (!slug) throw new Error("用法:node poller/run.mjs --test-buy 商品代碼");
  const { Buyer } = await import("./checkout.mjs");
  const base = process.env.BASE_URL || "https://shop.funbox.com.tw";
  const p = await fetchProduct(base, slug);
  log(`商品 ${slug}:${p.name || ""} ${p.exists ? (p.inStock ? "有貨" : "缺貨") : "頁面不存在"}`);
  if (!p.exists || !p.variantId) throw new Error("找不到商品或規格(variant_id)");
  const buyer = new Buyer(buyerOptions(base));
  await buyer.start();
  log("登入狀態:", buyer.status().msg);
  const r = await buyer.buy({
    slug,
    variantId: p.variantId,
    name: p.name,
    qty: 1,
    live: false,
    payment_keyword: process.env.PAYMENT_KEYWORD ?? "信用卡",
    shipping_keyword: process.env.SHIPPING_KEYWORD || "",
  });
  log("結果:", r.ok ? "成功" : "失敗", r.message);
  await buyer.close();
  if (!r.ok) process.exitCode = 1;
}

// ------------------------------------------------------------------ 常駐迴圈(家裡電腦選用)
async function runLoop() {
  if (!WORKER || !TOKEN) throw new Error("請設定 WORKER_URL 與 POLLER_TOKEN");
  const deadline = Date.now() + RUN_MS;
  log(`啟動(${RUNNER})`);

  let buyer = null;
  const notices = [];
  const buyerStatus = () => (buyer ? buyer.status() : { ok: false, msg: "下單程式未啟用(BUY_ENABLED=0)" });

  let plan = await report({ buyer: buyerStatus() });
  if (!plan) throw new Error("連不上 Worker,請確認 WORKER_URL");

  if (BUY_ON) {
    const { Buyer } = await import("./checkout.mjs");
    buyer = new Buyer(buyerOptions(plan.config.base_url));
    try {
      await buyer.start();
      log("下單程式:", buyer.status().msg);
      if (!buyer.status().ok) notices.push(buyer.status().msg);
    } catch (e) {
      log("下單程式啟動失敗:", e.message);
      notices.push(`下單程式啟動失敗:${e.message}`);
    }
    plan = (await report({ buyer: buyerStatus(), notices: notices.splice(0) })) || plan;
  }
  log(plan.enabled ? "控制台狀態:監控中" : "控制台狀態:已停止(等待在手機按「開始監控」)");

  const nextSrc = {};
  let nextPending = 0;
  let lastReport = Date.now();
  let lastKeepalive = Date.now();
  let wasEnabled = plan.enabled;

  while (Date.now() < deadline) {
    const now = Date.now();
    const payload = { buyer: buyerStatus(), notices: notices.splice(0), sources: [], products: [], orders: [] };
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

    for (let round = 0; round < 3; round++) {
      const res = await report(payload);
      lastReport = Date.now();
      if (!res) break;
      plan = res;
      const follow = { buyer: buyerStatus(), notices: [], products: [], orders: [] };
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

const entry = process.argv.includes("--test-buy") ? testBuy(TEST_SLUG) : ONCE ? runOnce() : runLoop();
entry.catch(async (e) => {
  console.error(ts(), "錯誤:", e.message);
  if (HOOK && !TEST_SLUG && !ONCE) {
    const { sendDiscordFile } = await import("./checkout.mjs").catch(() => ({}));
    if (sendDiscordFile) await sendDiscordFile(HOOK, `**⚠ 電腦上的偵測程式停止**\n${e.message}`).catch(() => {});
  }
  process.exitCode = 1;
});
