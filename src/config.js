// 預設設定與設定檢查(來源:funbox-sniper/config.yaml)

export const DEFAULT_CONFIG = {
  base_url: "https://shop.funbox.com.tw",
  sources: [
    {
      name: "beyblade-collection",
      url: "/collections/%E6%88%B0%E9%AC%A5%E9%99%80%E8%9E%BA?sort_by=created-descending",
      interval: 10,
    },
    { name: "all-newest", url: "/collections/all?sort_by=created-descending", interval: 10 },
  ],
  match: {
    slug_prefixes: ["bb"],
    include_keywords: ["戰鬥陀螺", "BEYBLADE"],
    exclude_keywords: ["APP兌換"],
  },
  pending: { interval: 2, timeout_minutes: 120 },
  notify: {
    mention: "", // 例:"<@你的DiscordID>" 或 "@everyone",確保手機一定跳通知
    max_unit_price: 0, // 0 = 不限制
    cart_link_template: "", // 可用 {base} {variant_id} {qty};空白 = 只附商品頁連結
    cart_qty: 1,
  },
  // 自動下單(由家裡電腦上的 poller 執行,用 FunboxSniper 的專屬 Chrome 與 card.dat)
  buy: {
    enabled: false, // 總開關
    live: false, // false = 演練(走到結帳頁就停),true = 真的送出訂單
    keywords: [], // 商品名稱含任一個才下單;留空 = 不下單
    quantity: 1,
    max_orders: 1, // 正式下單最多幾張,達到即停止
    payment_keyword: "信用卡", // 付款方式按鈕文字(銀行簡訊驗證需本人在電腦上的 Chrome 完成)
    shipping_keyword: "", // 運送方式按鈕文字,留空 = 網站預設
  },
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const strList = (v, maxItems = 50) =>
  (Array.isArray(v) ? v : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, maxItems);

/** 驗證並整理使用者送來的設定。回傳 { cfg } 或 { error }。 */
export function sanitizeConfig(input) {
  if (!input || typeof input !== "object") return { error: "設定格式錯誤" };

  const base = String(input.base_url || DEFAULT_CONFIG.base_url).trim().replace(/\/+$/, "");
  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    return { error: "網站網址格式錯誤" };
  }
  const isLocal = ["localhost", "127.0.0.1"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(isLocal && baseUrl.protocol === "http:")) {
    return { error: "網站網址必須是 https" };
  }

  const sources = [];
  const seen = new Set();
  for (const s of Array.isArray(input.sources) ? input.sources.slice(0, 10) : []) {
    const name = String(s?.name || "").trim();
    const url = String(s?.url || "").trim();
    if (!name || !url) return { error: "每個監控來源都要填名稱和網址" };
    if (seen.has(name)) return { error: `來源名稱重複:${name}` };
    seen.add(name);
    if (!url.startsWith("/") && !url.startsWith("https://")) {
      return { error: `來源網址要以 / 或 https:// 開頭:${name}` };
    }
    // 只允許抓取設定的網站,避免被拿去當跳板
    if (url.startsWith("https://") && new URL(url).host !== baseUrl.host) {
      return { error: `來源網址必須是 ${baseUrl.host} 網域:${name}` };
    }
    sources.push({ name, url, interval: clampInt(s.interval, 3, 3600, 10) });
  }
  if (!sources.length) return { error: "至少需要一個監控來源" };

  const m = input.match || {};
  const n = input.notify || {};
  const p = input.pending || {};
  const b = input.buy || {};
  const template = String(n.cart_link_template || "").trim();
  if (template && !(template.startsWith("{base}") || template.startsWith("https://"))) {
    return { error: "購物車連結範本必須以 https:// 或 {base} 開頭" };
  }

  return {
    cfg: {
      base_url: base,
      sources,
      match: {
        slug_prefixes: strList(m.slug_prefixes).map((s) => s.toLowerCase()),
        include_keywords: strList(m.include_keywords),
        exclude_keywords: strList(m.exclude_keywords),
      },
      pending: {
        interval: clampInt(p.interval, 2, 600, 2),
        timeout_minutes: clampInt(p.timeout_minutes, 1, 10080, 120),
      },
      notify: {
        mention: String(n.mention || "").trim().slice(0, 100),
        max_unit_price: Math.max(0, Number(n.max_unit_price) || 0),
        cart_link_template: template.slice(0, 300),
        cart_qty: clampInt(n.cart_qty, 1, 20, 1),
      },
      buy: {
        enabled: b.enabled === true,
        live: b.live === true,
        keywords: strList(b.keywords, 30),
        quantity: clampInt(b.quantity, 1, 20, 1),
        max_orders: clampInt(b.max_orders, 1, 20, 1),
        payment_keyword: String(b.payment_keyword ?? "").trim().slice(0, 40),
        shipping_keyword: String(b.shipping_keyword ?? "").trim().slice(0, 40),
      },
    },
  };
}

/** 舊版存檔沒有新欄位時補上預設值。 */
export function withDefaults(cfg) {
  const c = cfg || {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    match: { ...DEFAULT_CONFIG.match, ...c.match },
    pending: { ...DEFAULT_CONFIG.pending, ...c.pending },
    notify: { ...DEFAULT_CONFIG.notify, ...c.notify },
    buy: { ...DEFAULT_CONFIG.buy, ...c.buy },
  };
}
