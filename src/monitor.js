// Durable Object:監控的「大腦」。
// Funbox 會擋 Cloudflare Workers,所以「抓網頁」改由家裡電腦上的 poller/run.mjs 執行,
// 結果透過 POST /api/report 送進來;這裡負責判斷新品、追蹤補貨、Discord 通知、決定是否自動下單。
// 判斷邏輯移植自 funbox-sniper(detector.py + main.py)。
import { DurableObject } from "cloudflare:workers";
import { sanitizeConfig, withDefaults } from "./config.js";
import { extractSlugs, fetchText, looksBlocked, matches, prefixOk, productUrl, slugOf } from "./parse.js";

const MAX_LOGS = 150;
const MAX_KNOWN = 5000;
const MAX_DONE = 500;
const MAX_NEED = 15; // 每次回報最多要求抓幾個新商品頁
const MAX_PENDING = 15; // 每次最多檢查幾個追蹤中的商品
const POLLER_STALE_LOOP_MS = 90_000; // 本機常駐超過 90 秒沒回報視為離線
const POLLER_STALE_CRON_MS = 25 * 60_000; // GitHub Actions 排程可能延遲,超過 25 分鐘沒回報視為逾時
const STAGE_ORDER = { url: 0, listed: 1, stock: 2 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const twTime = () => new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, n = 200) => String(v ?? "").slice(0, n);

export class Monitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.dirty = false;
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = (await this.ctx.storage.get("state")) || {};
      this.s = {
        enabled: false,
        baselined: {},
        pending: {},
        announced: {},
        logs: [],
        src: {},
        poller: null,
        orders: { count: 0, items: {} },
        ...saved,
      };
      this.s.config = withDefaults(saved.config);
      this.s.orders ||= { count: 0, items: {} };
      this.s.src ||= {};
      this.known = new Set(saved.known || []);
      this.done = new Set(saved.done || []);
    });
    // 舊版用 alarm 自己抓網頁,已停用
    this.ctx.storage.deleteAlarm().catch(() => {});
  }

  // ---------------------------------------------------------------- 狀態
  async save() {
    while (this.known.size > MAX_KNOWN) this.known.delete(this.known.values().next().value);
    while (this.done.size > MAX_DONE) this.done.delete(this.done.values().next().value);
    const items = Object.entries(this.s.orders.items);
    if (items.length > 200) this.s.orders.items = Object.fromEntries(items.slice(-200));
    await this.ctx.storage.put("state", { ...this.s, known: [...this.known], done: [...this.done] });
    this.dirty = false;
  }

  log(level, msg) {
    this.s.logs.push({ t: Date.now(), l: level, m: msg });
    if (this.s.logs.length > MAX_LOGS) this.s.logs.splice(0, this.s.logs.length - MAX_LOGS);
    this.dirty = true;
  }

  track(slug, manual = false) {
    const cur = this.s.pending[slug];
    if (!cur) this.s.pending[slug] = { t: Date.now(), manual };
    else if (manual) cur.manual = true;
    this.dirty = true;
  }

  untrack(slug) {
    if (slug in this.s.pending) {
      delete this.s.pending[slug];
      this.dirty = true;
    }
  }

  markDone(slug) {
    this.done.add(slug);
    this.dirty = true;
  }

  pollerStaleMs(p = this.s.poller) {
    return p?.mode === "cron" ? POLLER_STALE_CRON_MS : POLLER_STALE_LOOP_MS;
  }

  pollerOnline() {
    return !!this.s.poller && Date.now() - this.s.poller.at < this.pollerStaleMs();
  }

  // ---------------------------------------------------------------- 通知
  async sendDiscord(text) {
    const hook = (this.env.DISCORD_WEBHOOK || "").trim();
    if (!hook) return { ok: false, error: "尚未設定 DISCORD_WEBHOOK" };
    const mention = this.s.config.notify.mention;
    const content = (mention ? `${mention}\n${text}` : text).slice(0, 1900);
    const body = {
      content,
      allowed_mentions: mention ? { parse: ["users", "roles", "everyone"] } : { parse: [] },
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (r.status === 429 && attempt === 0) {
          const j = await r.json().catch(() => ({}));
          await new Promise((res) => setTimeout(res, Math.min(Number(j.retry_after) || 1, 5) * 1000));
          continue;
        }
        if (r.status >= 300) return { ok: false, error: `Discord HTTP ${r.status}` };
        return { ok: true };
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    return { ok: false, error: "Discord 限流" };
  }

  async notify(headline, body, level = "notify") {
    const r = await this.sendDiscord(`**${headline}**\n${body}\n_${twTime()}_`);
    const first = body.split("\n")[0];
    this.log(r.ok ? level : "error", `${headline} ${first}${r.ok ? "" : `(Discord 失敗:${r.error})`}`);
  }

  /** 每個商品每個階段只通知一次。 */
  async announce(slug, stage, headline, p = null) {
    const prev = this.s.announced[slug];
    if (prev !== undefined && STAGE_ORDER[prev] >= STAGE_ORDER[stage]) return;
    this.s.announced[slug] = stage;
    this.dirty = true;

    const cfg = this.s.config;
    const url = productUrl(cfg.base_url, slug);
    let body;
    if (!p) {
      body = `代碼:${slug}\n${url}`;
    } else {
      body = `${p.name}\n價格:NT$${Math.round(p.price).toLocaleString("en-US")}\n庫存:${p.inStock ? "有貨" : "缺貨"}\n${url}`;
      const tpl = cfg.notify.cart_link_template;
      if (tpl && p.inStock && p.variantId) {
        const link = tpl
          .replaceAll("{base}", cfg.base_url)
          .replaceAll("{variant_id}", String(p.variantId))
          .replaceAll("{qty}", String(cfg.notify.cart_qty));
        body += `\n🛒 加入購物車:${link}`;
      }
    }
    await this.notify(headline, body);
  }

  // ---------------------------------------------------------------- 自動下單判斷
  /** 回傳命中的下單關鍵字;不下單則回傳 null。 */
  buyKeyword(p) {
    const b = this.s.config.buy;
    if (!b.enabled || !p.variantId || this.s.orders.items[p.slug]) return null;
    const name = p.name.toLowerCase();
    const kw = b.keywords.find((k) => name.includes(k.toLowerCase()));
    if (!kw) return null;
    if (b.live && this.s.orders.count >= b.max_orders) {
      this.log("warn", `已達下單上限 ${b.max_orders} 張,不再自動下單:${p.slug}`);
      return null;
    }
    return kw;
  }

  async queueBuy(p, kw, buys) {
    const b = this.s.config.buy;
    if (!this.pollerOnline() || !this.s.poller?.buyer) {
      await this.notify("⚠ 符合下單條件,但 電腦上的下單程式未就緒", `${p.name}\n請手動結帳:${productUrl(this.s.config.base_url, p.slug)}`, "warn");
      return;
    }
    this.s.orders.items[p.slug] = { t: Date.now(), state: "sent", live: b.live, name: p.name };
    this.dirty = true;
    buys.push({
      slug: p.slug,
      variantId: p.variantId,
      name: p.name,
      qty: b.quantity,
      live: b.live,
      payment_keyword: b.payment_keyword,
      shipping_keyword: b.shipping_keyword,
    });
    await this.notify(
      b.live ? "🛒 開始自動下單" : "🧪 開始演練下單(不會送出)",
      `${p.name}\n命中關鍵字:${kw}\n${productUrl(this.s.config.base_url, p.slug)}`,
    );
  }

  // ---------------------------------------------------------------- 處理回報
  /** 商品頁結果。res = { slug, first, ok, product?, error? } */
  async applyProduct(res, buys) {
    const slug = slugOf(str(res.slug, 300));
    if (!slug || this.done.has(slug)) return;
    const cfg = this.s.config;
    const first = !!res.first;
    const manual = !!this.s.pending[slug]?.manual;
    if (!res.ok) {
      this.log("warn", `讀取商品 ${slug} 失敗:${str(res.error)}`);
      this.track(slug);
      return;
    }
    const r = res.product || {};
    const p = {
      slug,
      name: str(r.name, 200),
      price: Number(r.price) || 0,
      variantId: r.variantId ?? null,
      exists: r.exists !== false,
      inStock: !!r.inStock,
    };
    if (!p.exists) {
      if (first && prefixOk(cfg, slug)) await this.announce(slug, "url", "🆕 發現新陀螺網址(頁面尚未開放)");
      this.track(slug);
      return;
    }
    if (!manual && !matches(cfg, p)) {
      this.untrack(slug);
      this.markDone(slug);
      return;
    }
    const cap = cfg.notify.max_unit_price;
    if (!manual && cap && p.price > cap) {
      this.log("info", `單價 ${p.price} 超過上限 ${cap},略過 ${slug}`);
      this.untrack(slug);
      this.markDone(slug);
      return;
    }
    if (p.inStock) {
      const head = manual
        ? "🔥 追蹤的商品有貨了"
        : this.s.announced[slug]
          ? "🔥 陀螺補貨 / 開賣了"
          : "🔥 新陀螺上架(有貨)";
      // 先排下單再通知,搶時間
      const kw = this.buyKeyword(p);
      if (kw) await this.queueBuy(p, kw, buys);
      await this.announce(slug, "stock", head, p);
      this.untrack(slug);
      this.markDone(slug);
    } else {
      await this.announce(slug, "listed", "🆕 新陀螺上架(目前缺貨,持續追蹤補貨)", p);
      this.track(slug);
    }
  }

  /** 列表頁結果。r = { name, ok, status, ms, slugs?, error? };新網址放進 need。 */
  applySource(r, need) {
    const cfg = this.s.config;
    const name = str(r.name, 60);
    if (!cfg.sources.some((s) => s.name === name)) return;
    const st = (this.s.src[name] ||= { scans: 0, ok: null, at: 0, ms: 0, count: 0, error: "" });
    st.at = Date.now();
    st.ms = Number(r.ms) || 0;
    this.dirty = true;
    const slugs = new Set(arr(r.slugs).slice(0, 2000).map((s) => slugOf(str(s, 300))).filter(Boolean));
    if (!r.ok || !slugs.size) {
      const msg = str(r.error || (r.ok ? "頁面沒有任何商品連結(可能被擋或網站改版)" : `HTTP ${r.status}`));
      st.ok = false;
      if (st.error !== msg) this.log("warn", `[${name}] ${msg}`);
      st.error = msg;
      return;
    }
    if (st.error) this.log("info", `[${name}] 恢復正常`);
    Object.assign(st, { ok: true, error: "", count: slugs.size, scans: st.scans + 1 });

    if (!this.s.baselined[name]) {
      for (const s of slugs) this.known.add(s);
      this.s.baselined[name] = true;
      this.log("info", `[${name}] 建立基準:${slugs.size} 件商品,既有商品不通知`);
      return;
    }
    const fresh = [...slugs].filter((s) => !this.known.has(s));
    if (!fresh.length) return;
    for (const s of fresh) this.known.add(s);
    fresh.sort((a, b) => Number(prefixOk(cfg, b)) - Number(prefixOk(cfg, a)));
    this.log("info", `[${name}] 發現新商品網址 ${fresh.length} 件:${fresh.slice(0, MAX_NEED).join(", ")}`);
    for (const s of fresh) need.add(s);
  }

  /** 下單結果。r = { slug, ok, dry_run, message, url? } */
  async applyOrder(r) {
    const slug = slugOf(str(r.slug, 300));
    const item = this.s.orders.items[slug] || (this.s.orders.items[slug] = { t: Date.now() });
    const msg = str(r.message, 400);
    item.state = r.ok ? (r.dry_run ? "dry" : "ok") : "fail";
    item.message = msg;
    this.dirty = true;
    const url = productUrl(this.s.config.base_url, slug);
    const name = item.name || slug;
    if (r.ok && !r.dry_run) {
      this.s.orders.count++;
      await this.notify("✅ 自動下單完成", `${name}\n${msg}\n請到 Funbox 會員中心確認訂單並完成付款。`);
    } else if (r.ok) {
      await this.notify("🧪 演練完成(未送出訂單)", `${name}\n${msg}`);
    } else {
      await this.notify("❌ 自動下單失敗,請立刻手動結帳", `${name}\n${msg}\n${url}`, "error");
    }
  }

  async report(b) {
    const buys = [];
    const prev = this.s.poller;
    const mode = b.mode === "cron" ? "cron" : "loop";
    const buyer = b.buyer && typeof b.buyer === "object" ? { ok: !!b.buyer.ok, msg: str(b.buyer.msg, 200) } : null;
    const runner = str(b.runner, 80) || (mode === "cron" ? "GitHub Actions" : "偵測程式");
    const wasStale = !prev || Date.now() - prev.at > this.pollerStaleMs(prev);
    this.s.poller = { at: Date.now(), runner, mode, buyer: buyer?.ok ? true : false, buyerMsg: buyer?.msg || "" };
    if (wasStale || prev?.runner !== runner) this.log("info", `偵測程式已連線(${runner})`);
    this.dirty = true;

    for (const n of arr(b.notices).slice(0, 5)) await this.notify("⚠ 電腦下單程式", str(n, 400), "warn");
    for (const o of arr(b.orders).slice(0, 10)) await this.applyOrder(o);

    const need = new Set();
    if (this.s.enabled) {
      for (const r of arr(b.sources).slice(0, 10)) this.applySource(r, need);
      // 商品逐一處理(依序,避免同一商品重複下單)
      for (const r of arr(b.products).slice(0, 40)) await this.applyProduct(r, buys);

      const cfg = this.s.config;
      const now = Date.now();
      for (const [slug, v] of Object.entries(this.s.pending)) {
        if (now - v.t > cfg.pending.timeout_minutes * 60_000) {
          this.log("info", `追蹤逾時,放棄 ${slug}`);
          this.untrack(slug);
        }
      }
    }
    if (this.dirty) await this.save();

    const cfg = this.s.config;
    return {
      enabled: this.s.enabled,
      config: {
        base_url: cfg.base_url,
        sources: cfg.sources,
        pending_interval: cfg.pending.interval,
        buy_enabled: cfg.buy.enabled,
      },
      need: [...need].slice(0, MAX_NEED),
      pending: Object.entries(this.s.pending)
        .sort((a, b) => a[1].t - b[1].t)
        .slice(0, MAX_PENDING)
        .map(([s]) => s),
      buys,
    };
  }

  // ---------------------------------------------------------------- HTTP 介面
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const body = ["POST", "PUT"].includes(method) ? await request.json().catch(() => ({})) : {};

    if (method === "GET" && path === "/state") return json(this.snapshot());

    if (method === "POST" && path === "/report") return json(await this.report(body));

    if (method === "POST" && path === "/start") {
      this.s.enabled = true;
      this.log("info", "▶ 開始監控");
      await this.save();
      return json({ ok: true });
    }

    if (method === "POST" && path === "/stop") {
      this.s.enabled = false;
      this.log("info", "■ 停止監控");
      await this.save();
      return json({ ok: true });
    }

    if (method === "PUT" && path === "/config") {
      const { cfg, error } = sanitizeConfig(body);
      if (error) return json({ error }, 400);
      const prevBuy = this.s.config.buy;
      this.s.config = cfg;
      const names = new Set(cfg.sources.map((s) => s.name));
      for (const n of Object.keys(this.s.baselined)) if (!names.has(n)) delete this.s.baselined[n];
      for (const n of Object.keys(this.s.src)) if (!names.has(n)) delete this.s.src[n];
      this.log("info", "設定已更新");
      if (cfg.buy.live && !prevBuy.live) this.log("warn", "⚠ 已切換為「正式下單」模式");
      await this.save();
      return json({ ok: true, config: cfg });
    }

    if (method === "POST" && path === "/watch") {
      const slug = slugOf(String(body.input || "").trim());
      if (!slug || /\s/.test(slug)) return json({ error: "請輸入商品網址或代碼" }, 400);
      this.done.delete(slug);
      delete this.s.announced[slug];
      this.track(slug, true);
      this.log("info", `手動加入追蹤:${slug}(下次掃描時檢查)`);
      await this.save();
      return json({ ok: true, slug });
    }

    if (method === "DELETE" && path.startsWith("/pending/")) {
      this.untrack(decodeURIComponent(path.slice("/pending/".length)));
      await this.save();
      return json({ ok: true });
    }

    if (method === "POST" && path === "/reset") {
      this.known = new Set();
      this.done = new Set();
      this.s.baselined = {};
      this.s.announced = {};
      this.log("info", "已重設基準:下次掃描會重新記錄既有商品");
      await this.save();
      return json({ ok: true });
    }

    if (method === "POST" && path === "/reset-orders") {
      this.s.orders = { count: 0, items: {} };
      this.log("info", "已清除下單紀錄與計數");
      await this.save();
      return json({ ok: true });
    }

    if (method === "POST" && path === "/clear-logs") {
      this.s.logs = [];
      await this.save();
      return json({ ok: true });
    }

    if (method === "POST" && path === "/test-discord") {
      const r = await this.sendDiscord(`✅ **Funbox 監控測試通知**\n_${twTime()}_`);
      return json(r, r.ok ? 200 : 400);
    }

    if (method === "POST" && path === "/test-fetch") {
      // 從 Cloudflare 直接讀(預期會被擋,僅供診斷)
      const results = await Promise.all(
        this.s.config.sources.map(async (src) => {
          const t0 = Date.now();
          try {
            const u = src.url.startsWith("http") ? src.url : this.s.config.base_url + src.url;
            const { resp, text } = await fetchText(u);
            const blocked = looksBlocked(resp, text);
            const slugs = resp.ok && !blocked ? extractSlugs(text).size : 0;
            return { name: src.name, status: resp.status, ms: Date.now() - t0, slugs, blocked, ok: resp.ok && !blocked && slugs > 0 };
          } catch (e) {
            return { name: src.name, ok: false, ms: Date.now() - t0, error: String(e.message || e) };
          }
        }),
      );
      return json({ results });
    }

    return json({ error: "not found" }, 404);
  }

  snapshot() {
    const cfg = this.s.config;
    return {
      now: Date.now(),
      enabled: this.s.enabled,
      pollerOnline: this.pollerOnline(),
      poller: this.s.poller,
      hasWebhook: !!(this.env.DISCORD_WEBHOOK || "").trim(),
      hasPollerToken: (this.env.POLLER_TOKEN || "").length >= 16,
      config: cfg,
      sources: cfg.sources.map((s) => ({
        name: s.name,
        ...(this.s.src[s.name] || { scans: 0, ok: null, at: 0, ms: 0, count: 0, error: "" }),
      })),
      pending: Object.entries(this.s.pending).map(([slug, v]) => ({ slug, since: v.t, manual: !!v.manual })),
      orders: {
        count: this.s.orders.count,
        items: Object.entries(this.s.orders.items)
          .slice(-10)
          .reverse()
          .map(([slug, v]) => ({ slug, ...v })),
      },
      knownCount: this.known.size,
      logs: this.s.logs.slice(-100),
    };
  }
}
