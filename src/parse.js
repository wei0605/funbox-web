// 商品頁解析與條件比對(移植自 funbox-sniper/sniper/product.py)

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "zh-TW,zh;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const PRODUCT_LINK = /(?:href=["']|<loc>)(?:https?:\/\/[^\/"'<]+)?(\/products\/[^"'?#<\s]+)/g;
const PRODUCT_DATA = /var productData\s*=\s*(\[.*?\]);/s;

export class HttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

export function slugOf(pathOrUrl) {
  let path = pathOrUrl;
  if (path.includes("://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* 保持原樣 */
    }
  }
  const last = path.replace(/\/+$/, "").split("/").pop() || "";
  try {
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return last.toLowerCase();
  }
}

export function extractSlugs(text) {
  const out = new Set();
  for (const m of text.matchAll(PRODUCT_LINK)) out.add(slugOf(m[1]));
  out.delete("");
  return out;
}

/** 偵測 Cloudflare 驗證頁(HTTP 200 但內容是挑戰頁)。 */
export function looksBlocked(resp, text) {
  if (resp.headers.get("cf-mitigated") === "challenge") return true;
  return /<title>\s*Just a moment|Attention Required! \| Cloudflare|cf-browser-verification/i.test(text);
}

export async function fetchText(url, timeoutMs = 8000) {
  const resp = await fetch(url, {
    headers: HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = resp.status === 404 ? "" : await resp.text();
  return { resp, text };
}

export function productUrl(base, slug) {
  return `${base.replace(/\/+$/, "")}/products/${slug}`;
}

/** 回傳 { slug, name, price, variantId, status, exists, soldOutButton, inStock } */
export async function fetchProduct(base, slug) {
  const p = {
    slug,
    name: "",
    price: 0,
    variantId: null,
    status: "unknown",
    exists: true,
    soldOutButton: false,
  };
  const { resp, text: html } = await fetchText(productUrl(base, slug));
  if (resp.status === 404) {
    p.exists = false;
    p.inStock = false;
    return p;
  }
  if (!resp.ok) throw new HttpError(resp.status);
  if (looksBlocked(resp, html)) throw new HttpError(403, "被 Cloudflare 驗證頁擋下");

  const m = PRODUCT_DATA.exec(html);
  if (m) {
    try {
      const items = JSON.parse(m[1]);
      // 多規格商品:優先挑有貨的規格
      const item = items.find((i) => i.inventory_quantity_status !== "empty") || items[0];
      p.name = item.name || "";
      p.price = parseFloat(item.price || 0) || 0;
      p.variantId = item.variant_id ?? null;
      p.status = item.inventory_quantity_status || "unknown";
    } catch {
      /* 解析失敗就用 title */
    }
  }
  if (!p.name) {
    const t = /<title>\s*([\s\S]*?)\s*<\/title>/.exec(html);
    p.name = t ? t[1] : slug;
  }
  // 補強:按鈕文字顯示「售完」
  const btn = /<button[^>]*btn_to_cart[^>]*>([\s\S]*?)<\/button>/.exec(html);
  if (btn && btn[1].includes("售完")) p.soldOutButton = true;

  p.inStock = p.exists && p.status !== "empty" && !p.soldOutButton;
  return p;
}

export function prefixOk(cfg, slug) {
  return (cfg.match.slug_prefixes || []).some((pre) => slug.startsWith(pre.toLowerCase()));
}

export function matches(cfg, p) {
  const m = cfg.match;
  const name = p.name.toLowerCase();
  if ((m.exclude_keywords || []).some((k) => name.includes(k.toLowerCase()))) return false;
  if (prefixOk(cfg, p.slug)) return true;
  return (m.include_keywords || []).some((k) => name.includes(k.toLowerCase()));
}
