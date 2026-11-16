// 輪詢程式:跑在 GitHub Actions(或任何 Node 18+ 環境)。
// 負責「抓 Funbox 網頁」(Cloudflare Worker 會被 Funbox 擋 403),
// 抓到的資料交給 Worker 判斷新品 / 補貨並通知。
//
// 環境變數:
//   WORKER_URL          例:https://funbox-watch.xxx.workers.dev
//   ADMIN_TOKEN         控制台的管理密碼
//   POLL_LOOP_SECONDS   (選用)大於 0 時,同一次執行內重複輪詢這麼多秒;預設 0 = 只跑一輪
import { HttpError, extractSlugs, fetchProduct, fetchText, looksBlocked } from "../src/parse.js";

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.ADMIN_TOKEN || "";
const LOOP_SECONDS = Math.max(0, Number(process.env.POLL_LOOP_SECONDS) || 0);

if (!WORKER_URL || !TOKEN) {
  console.error("缺少 WORKER_URL 或 ADMIN_TOKEN");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = "GET", body) {
  const r = await fetch(`${WORKER_URL}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) throw new Error("Worker 回 401:ADMIN_TOKEN 不正確");
  if (!r.ok) throw new Error(`Worker ${path} 回 HTTP ${r.status}`);
  return r.json();
}

async function scanSource(base, src) {
  const t0 = Date.now();
  const url = src.url.startsWith("http") ? src.url : base + src.url;
  try {
    const { resp, text } = await fetchText(url, 15000);
    if (!resp.ok) throw new HttpError(resp.status);
    if (looksBlocked(resp, text)) throw new HttpError(403, "被 Cloudflare 驗證頁擋下");
    return { name: src.name, ok: true, ms: Date.now() - t0, slugs: [...extractSlugs(text)] };
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "連線逾時" : e.message;
    return { name: src.name, ok: false, ms: Date.now() - t0, error: msg };
  }
}

async function onePass() {
  const plan = await api("/poll-plan");
  if (!plan.enabled) {
    console.log("監控已在控制台停止,略過本輪");
    return plan;
  }

  const results = await Promise.all(plan.sources.map((s) => scanSource(plan.base_url, s)));
  for (const r of results) {
    console.log(r.ok ? `[${r.name}] ${r.slugs.length} 件商品 (${r.ms}ms)` : `[${r.name}] 失敗:${r.error}`);
  }

  const { fetch: want } = await api("/ingest", "POST", { sources: results });
  if (!want.length) return plan;

  console.log(`抓取 ${want.length} 個商品頁:${want.join(", ")}`);
  const products = await Promise.all(
    want.map((slug) =>
      fetchProduct(plan.base_url, slug).catch((e) => ({ slug, error: e.message || String(e) })),
    ),
  );
  await api("/ingest-products", "POST", { products });
  return plan;
}

const started = Date.now();
let failures = 0;
do {
  let plan;
  try {
    plan = await onePass();
  } catch (e) {
    failures++;
    console.error("本輪失敗:", e.message);
  }
  if (!LOOP_SECONDS) break;
  const every = Math.max(10, Math.min(...(plan?.sources || [{ interval: 10 }]).map((s) => s.interval || 10)));
  await sleep(every * 1000);
} while (Date.now() - started < LOOP_SECONDS * 1000);

// 全部都失敗才讓 workflow 顯示紅色,方便在 GitHub 上看出異常
process.exit(LOOP_SECONDS ? 0 : failures ? 1 : 0);
