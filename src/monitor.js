// Durable Object:保存狀態,接收外部輪詢程式(GitHub Actions)回報的資料,
// 判斷新品 / 補貨並發 Discord 通知。邏輯移植自 funbox-sniper 的「僅通知」模式。
//
// 為什麼不在 Worker 裡直接抓 Funbox:Funbox 會對 Cloudflare Workers 回 403,
// 所以「抓網頁」放到 poller/run.mjs(跑在 GitHub Actions),這裡只做判斷與通知。
import { DurableObject } from "cloudflare:workers";
import { DEFAULT_CONFIG, sanitizeConfig } from "./config.js";
import { matches, prefixOk, productUrl, slugOf } from "./parse.js";

const MAX_LOGS = 150;
const MAX_KNOWN = 5000;
const MAX_DONE = 500;
const MAX_FETCH_PER_RUN = 30; // 每輪最多請輪詢程式抓幾個商品頁
const MAX_SLUGS_PER_SOURCE = 3000;
const STAGE_ORDER = { url: 0, listed: 1, stock: 2 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const twTime = () =>
  new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });

const str = (v, max) => String(v ?? "").slice(0, max);

export class Monitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.dirty = false;
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = (await this.ctx.storage.get("state")) || {};
      this.s = {
        enabled: false,
        config: DEFAULT_CONFIG,
        baselined: {},
        pending: {},
        announced: {},
        src: {}, // 各來源最近一次回報狀態
        lastIngestAt: 0,
        logs: [],
        ...saved,
      };
      this.known = new Set(saved.known || []);
      this.done = new Set(saved.done || []);
      await this.ctx.storage.deleteAlarm(); // 清除舊版(自己輪詢)留下的排程
    });
  }

  // ---------------------------------------------------------------- 狀態
  async save() {
    while (this.known.size > MAX_KNOWN) this.known.delete(this.known.values().next().value);
    while (this.done.size > MAX_DONE) this.done.delete(this.done.values().next().value);
    await this.ctx.storage.put("state", {
      ...this.s,
      known: [...this.known],
      done: [...this.done],
    });
    this.dirty = false;
  }

  log(level, msg) {
    this.s.logs.push({ t: Date.now(), l: level, m: msg });
    if (this.s.logs.length > MAX_LOGS) this.s.logs.splice(0, this.s.logs.length - MAX_LOGS);
    this.dirty = true;
  }

  track(slug, manual = false) {
    const cur = this.s.pending[slug];
    if (!cur) {
      this.s.pending[slug] = { t: Date.now(), manual };
      this.dirty = true;
    } else if (manual && !cur.manual) {
      cur.manual = true;
      this.dirty = true;
    }
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
    const r = await this.sendDiscord(`**${headline}**\n${body}\n_${twTime()}_`);
    this.log(r.ok ? "notify" : "error", `${headline} ${slug}${r.ok ? "" : `(Discord 失敗:${r.error})`}`);
  }

  // ---------------------------------------------------------------- 商品評估
  /** p 是輪詢程式抓回來並解析好的商品資料。 */
  async evaluate(slug, p) {
    if (this.done.has(slug)) return;
    const cfg = this.s.config;
    const manual = !!this.s.pending[slug]?.manual;

    if (!p.exists) {
      // 網址剛出現但頁面尚未開放:持續追蹤
      if (!manual && prefixOk(cfg, slug)) {
        await this.announce(slug, "url", "🆕 發現新陀螺網址(頁面尚未開放)");
      }
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
      await this.announce(slug, "stock", head, p);
      this.untrack(slug);
      this.markDone(slug);
    } else {
      await this.announce(slug, "listed", "🆕 新陀螺上架(目前缺貨,持續追蹤補貨)", p);
      this.track(slug);
    }
  }

  // ---------------------------------------------------------------- 輪詢程式的介面
  /** 輪詢程式一開始先問:要不要做事、抓哪些來源、有哪些追蹤中的商品。 */
  pollPlan() {
    const cfg = this.s.config;
    const now = Date.now();
    for (const [slug, v] of Object.entries(this.s.pending)) {
      if (now - v.t > cfg.pending.timeout_minutes * 60_000) {
        this.log("info", `追蹤逾時,放棄 ${slug}`);
        this.untrack(slug);
      }
    }
    return {
      enabled: this.s.enabled,
      base_url: cfg.base_url,
      sources: cfg.sources,
      pending: Object.keys(this.s.pending),
    };
  }

  /** 收下各來源的商品列表 → 回覆需要抓商品頁的代碼。 */
  async ingest(body) {
    if (!this.s.enabled) return { fetch: [] };
    const cfg = this.s.config;
    this.s.lastIngestAt = Date.now();
    const names = new Set(cfg.sources.map((s) => s.name));
    const fresh = [];

    for (const r of Array.isArray(body.sources) ? body.sources : []) {
      const name = str(r?.name, 100);
      if (!names.has(name)) continue;
      const st = (this.s.src[name] ||= { scans: 0, ok: null, at: 0, ms: 0, count: 0, error: "" });
      st.at = Date.now();
      st.ms = Math.max(0, Math.round(Number(r.ms) || 0));

      if (!r.ok) {
        const msg = str(r.error || "抓取失敗", 200);
        if (st.error !== msg) this.log("warn", `[${name}] ${msg}`);
        st.ok = false;
        st.error = msg;
        continue;
      }
      const slugs = (Array.isArray(r.slugs) ? r.slugs : [])
        .slice(0, MAX_SLUGS_PER_SOURCE)
        .map((s) => str(s, 200).toLowerCase())
        .filter(Boolean);
      if (!slugs.length) {
        st.ok = false;
        st.error = "頁面沒有任何商品連結(可能被擋或網站改版)";
        this.log("warn", `[${name}] ${st.error}`);
        continue;
      }
      if (st.error) this.log("info", `[${name}] 恢復正常`);
      st.ok = true;
      st.error = "";
      st.scans++;
      st.count = slugs.length;

      if (!this.s.baselined[name]) {
        for (const s of slugs) this.known.add(s);
        this.s.baselined[name] = true;
        this.log("info", `[${name}] 建立基準:${slugs.length} 件商品,既有商品不通知`);
        continue;
      }
      for (const s of slugs) {
        if (!this.known.has(s)) {
          this.known.add(s);
          fresh.push(s);
        }
      }
    }

    fresh.sort((a, b) => Number(prefixOk(cfg, b)) - Number(prefixOk(cfg, a)));
    if (fresh.length) {
      this.log("info", `發現新商品網址 ${fresh.length} 件:${fresh.slice(0, MAX_FETCH_PER_RUN).join(", ")}`);
      if (fresh.length > MAX_FETCH_PER_RUN) {
        this.log("warn", `一次出現太多新商品,只處理前 ${MAX_FETCH_PER_RUN} 件`);
      }
    }
    const pending = Object.keys(this.s.pending);
    const want = [...new Set([...fresh, ...pending])].filter((s) => !this.done.has(s));
    await this.save();
    return { fetch: want.slice(0, MAX_FETCH_PER_RUN) };
  }

  /** 收下輪詢程式抓回來的商品資料並評估。 */
  async ingestProducts(body) {
    if (!this.s.enabled) return { ok: true };
    this.s.lastIngestAt = Date.now();
    for (const raw of Array.isArray(body.products) ? body.products.slice(0, MAX_FETCH_PER_RUN) : []) {
      const slug = str(raw?.slug, 200).toLowerCase();
      if (!slug) continue;
      if (raw.error) {
        this.log("warn", `抓取 ${slug} 失敗:${str(raw.error, 120)}`);
        this.track(slug);
        continue;
      }
      const exists = raw.exists !== false;
      const p = {
        slug,
        exists,
        name: str(raw.name, 200) || slug,
        price: Number(raw.price) || 0,
        variantId: raw.variantId ?? null,
        status: str(raw.status, 40) || "unknown",
        soldOutButton: !!raw.soldOutButton,
      };
      p.inStock = p.exists && p.status !== "empty" && !p.soldOutButton;
      await this.evaluate(slug, p);
    }
    await this.save();
    return { ok: true };
  }

  // ---------------------------------------------------------------- HTTP 介面
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const body = ["POST", "PUT"].includes(method) ? await request.json().catch(() => ({})) : {};

    if (method === "GET" && path === "/state") return json(this.snapshot());

    if (method === "GET" && path === "/poll-plan") {
      const plan = this.pollPlan();
      if (this.dirty) await this.save();
      return json(plan);
    }
    if (method === "POST" && path === "/ingest") return json(await this.ingest(body));
    if (method === "POST" && path === "/ingest-products") return json(await this.ingestProducts(body));

    if (method === "POST" && path === "/start") {
      this.s.enabled = true;
      this.log("info", "▶ 開始監控(由輪詢程式定時回報)");
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
      this.s.config = cfg;
      // 移除已刪除來源的基準與狀態,新來源會重新建立基準
      const names = new Set(cfg.sources.map((s) => s.name));
      for (const n of Object.keys(this.s.baselined)) if (!names.has(n)) delete this.s.baselined[n];
      for (const n of Object.keys(this.s.src)) if (!names.has(n)) delete this.s.src[n];
      this.log("info", "設定已更新");
      await this.save();
      return json({ ok: true, config: cfg });
    }

    if (method === "POST" && path === "/watch") {
      const raw = String(body.input || "").trim();
      const slug = slugOf(raw);
      if (!slug || /\s/.test(slug)) return json({ error: "請輸入商品網址或代碼" }, 400);
      this.done.delete(slug);
      delete this.s.announced[slug];
      this.track(slug, true);
      this.log("info", `手動加入追蹤:${slug}(下次輪詢時檢查)`);
      await this.save();
      return json({ ok: true, slug });
    }

    if (method === "DELETE" && path.startsWith("/pending/")) {
      const slug = decodeURIComponent(path.slice("/pending/".length));
      this.untrack(slug);
      await this.save();
      return json({ ok: true });
    }

    if (method === "POST" && path === "/reset") {
      this.known = new Set();
      this.done = new Set();
      this.s.baselined = {};
      this.s.announced = {};
      this.log("info", "已重設基準:下次輪詢會重新記錄既有商品");
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

    return json({ error: "not found" }, 404);
  }

  snapshot() {
    const cfg = this.s.config;
    return {
      now: Date.now(),
      enabled: this.s.enabled,
      lastIngestAt: this.s.lastIngestAt,
      hasWebhook: !!(this.env.DISCORD_WEBHOOK || "").trim(),
      config: cfg,
      sources: cfg.sources.map((s) => ({
        name: s.name,
        ...(this.s.src[s.name] || { scans: 0, ok: null, at: 0, ms: 0, count: 0, error: "" }),
      })),
      pending: Object.entries(this.s.pending).map(([slug, v]) => ({ slug, since: v.t, manual: !!v.manual })),
      knownCount: this.known.size,
      logs: this.s.logs.slice(-100),
    };
  }
}
