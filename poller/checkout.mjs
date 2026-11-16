// 自動下單(移植自 funbox-sniper/sniper/buyer.py),在「您家裡的電腦」執行:
// - 連接 FunboxSniper 開的專屬 Chrome(偵錯埠 9222,保留會員登入);沒開的話自動用同一個設定檔開啟。
// - 信用卡用 FunboxSniper「設定 / 更換信用卡」存的 card.dat(Windows DPAPI 加密,只有您的 Windows 帳號能解開)。
// - 銀行 3D / 簡訊驗證仍需您本人在那個 Chrome 視窗完成;程式會發 Discord 通知提醒。
// 安全設計:
// - 不破解驗證碼、Cloudflare 驗證、簡訊或 3D 驗證。
// - 購物車不是剛好 1 項就不送出,避免誤購。
// - 填入卡號後絕不截圖;卡號、有效期限、CVV 不寫進日誌或通知。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ADD_TO_CART_JS = async ({ id, qty }) => {
  const r = await fetch("/cart/add", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
    body: "id=" + encodeURIComponent(id) + "&quantity=" + qty,
  });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
};

const CAPTCHA_SELECTORS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='turnstile']",
  "iframe[src*='challenges.cloudflare.com']",
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
];

const CHROME_PATHS = [
  "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
  "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
  "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => String(e?.message || e).split("\n")[0];

/** 用 Windows DPAPI 解開 FunboxSniper 的 card.dat(與 sniper/cardstore.py 相同的加密參數)。 */
export function loadCardFile(path) {
  if (!path || !existsSync(path)) return null;
  if (process.platform !== "win32") throw new Error("card.dat 只能在 Windows 解密");
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[IO.File]::ReadAllBytes($env:FB_CARD_PATH);" +
    "$e=[Text.Encoding]::ASCII.GetBytes('funbox-sniper-card-v1');" +
    "$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Convert]::ToBase64String($r)";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, FB_CARD_PATH: path },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  const d = JSON.parse(Buffer.from(out.trim(), "base64").toString("utf8"));
  const card = { number: String(d.number || ""), expiry: String(d.expiry || ""), cvv: String(d.cvv || ""), holder: String(d.holder || "") };
  if (!card.number || !card.expiry || !card.cvv) throw new Error("card.dat 內容不完整");
  return card;
}

const masked = (n) => (n.length >= 4 ? `末四碼 ${n.slice(-4)}` : "未設定");

/** 傳文字(和選填的截圖)到 Discord。 */
export async function sendDiscordFile(hook, text, png = null) {
  if (!hook) return false;
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }));
  if (png) form.append("files[0]", new Blob([png], { type: "image/png" }), "checkout.png");
  const r = await fetch(hook, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  return r.ok;
}

async function debugReady(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 確保專屬 Chrome 以偵錯模式執行(一般方式啟動,不帶自動化旗標,Cloudflare 才不會擋)。 */
async function ensureChrome({ port, profile, chromePath, url }) {
  if (await debugReady(port)) return;
  const exe = chromePath || CHROME_PATHS.map((p) => p.replace(/%([^%]+)%/g, (_, k) => process.env[k] || "")).find((p) => existsSync(p));
  if (!exe) throw new Error("找不到 Google Chrome,請在 local.env 設定 CHROME_PATH");
  if (!profile) throw new Error("請在 local.env 設定 CHROME_PROFILE");
  spawn(
    exe,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--profile-directory=Default", "--no-first-run", "--no-default-browser-check", "--lang=zh-TW", url],
    { detached: true, stdio: "ignore", windowsHide: false },
  ).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await debugReady(port)) return;
  }
  throw new Error(`Chrome 已啟動但偵錯埠 ${port} 沒有回應。請關閉所有 FunboxSniper 開的 Chrome 視窗後再試`);
}

export class Buyer {
  /**
   * opts: { base, hook, log, port=9222, profile, chromePath, cardFile, loadCard? }
   */
  constructor(opts) {
    this.base = opts.base.replace(/\/+$/, "");
    this.hook = opts.hook;
    this.log = opts.log || console.log;
    this.port = Number(opts.port) || 9222;
    this.profile = opts.profile;
    this.chromePath = opts.chromePath;
    this.cardFile = opts.cardFile;
    this.loadCard = opts.loadCard || (() => loadCardFile(this.cardFile));
    this.ready = false;
    this.loginState = { ok: false, msg: "尚未啟動" };
    this.busy = false;
    this.cardFilled = false;
  }

  status() {
    return this.loginState;
  }

  async start() {
    const { chromium } = await import("playwright-core");
    this.chromium = chromium;
    await this.connect();
    // 檢查信用卡(只回報是否可用,不印卡號)
    try {
      const card = this.loadCard();
      this.cardInfo = card ? `信用卡 ${masked(card.number)}` : "未設定信用卡(請在 FunboxSniper 設定)";
    } catch (e) {
      this.cardInfo = `信用卡讀取失敗:${firstLine(e)}`;
    }
    this.log("下單程式:", this.cardInfo);
    this.ready = true;
    await this.keepalive();
  }

  async connect() {
    await ensureChrome({ port: this.port, profile: this.profile, chromePath: this.chromePath, url: this.base });
    this.browser = await this.chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
    this.browser.on("disconnected", () => {
      this.browser = null;
      this.page = null;
    });
    this.ctx = this.browser.contexts()[0] || (await this.browser.newContext());
    this.page = await this.ctx.newPage();
  }

  /** Chrome 被關掉或分頁不見時重新連線。 */
  async ensurePage() {
    if (this.browser && this.page && !this.page.isClosed()) return;
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    await this.connect();
  }

  async close() {
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
      await this.browser?.close(); // CDP 連線:只中斷連線,Chrome 會繼續開著(保留登入)
    } catch {
      /* ignore */
    }
    this.ready = false;
  }

  /** 開首頁確認還在登入狀態。 */
  async keepalive() {
    if (this.busy) return;
    try {
      await this.ensurePage();
      const resp = await this.page.goto(this.base, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.page.waitForTimeout(1500);
      if (await this.blocked()) {
        this.loginState = { ok: false, msg: "Chrome 出現 Cloudflare 驗證,請在電腦上的 Chrome 完成驗證" };
        return;
      }
      if (resp && resp.status() >= 400) {
        this.loginState = { ok: false, msg: `開啟 Funbox 首頁失敗(HTTP ${resp.status()})` };
        return;
      }
      const raw = await this.page.evaluate(() => localStorage.getItem("customer"));
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        /* ignore */
      }
      const card = this.cardInfo ? `,${this.cardInfo}` : "";
      if (data && data.id && !data.notLogin) this.loginState = { ok: true, msg: `已登入 Funbox 會員${card}` };
      else this.loginState = { ok: false, msg: "Funbox 未登入:請在電腦上的專屬 Chrome 登入會員" };
    } catch (e) {
      this.loginState = { ok: false, msg: `檢查登入失敗:${firstLine(e)}` };
    }
  }

  async blocked() {
    const title = await this.page.title().catch(() => "");
    if (/Just a moment|Attention Required/i.test(title)) return true;
    for (const sel of CAPTCHA_SELECTORS) {
      const loc = this.page.locator(sel).first();
      if ((await loc.count()) && (await loc.isVisible().catch(() => false))) return true;
    }
    return false;
  }

  async shot() {
    if (this.cardFilled) return null; // 頁面上有卡號,不截圖
    try {
      return await this.page.screenshot({ fullPage: true });
    } catch {
      return null;
    }
  }

  async discord(text, png = null) {
    try {
      await sendDiscordFile(this.hook, text, png);
    } catch {
      /* 通知失敗不影響下單 */
    }
  }

  /** order = { slug, variantId, name, qty, live, payment_keyword, shipping_keyword } */
  async buy(order) {
    if (!this.ready) return { slug: order.slug, ok: false, dry_run: !order.live, message: "下單程式未啟動" };
    this.busy = true;
    this.cardFilled = false;
    const t0 = Date.now();
    try {
      await this.ensurePage();
      const r = await this._buy(order, t0);
      return { slug: order.slug, dry_run: !order.live, ...r };
    } catch (e) {
      const msg = `下單流程錯誤:${firstLine(e)}`;
      await this.discord(`**❌ ${order.name}**\n${msg}`, await this.shot());
      return { slug: order.slug, ok: false, dry_run: !order.live, message: msg };
    } finally {
      this.busy = false;
    }
  }

  /** 在 CYBERBIZ PAYMENTS 信用卡 iframe 逐字填卡並讀回比對。回傳 "filled" | "nocard" | "failed"。 */
  async fillCard(page) {
    let card;
    try {
      card = this.loadCard();
    } catch (e) {
      this.log("讀取信用卡失敗:", firstLine(e));
      return "nocard";
    }
    if (!card) return "nocard";
    const fr = page.frameLocator("#cyberbizpay-main-iframe");
    const exp = card.expiry.replace("/", "");
    try {
      await fr.locator("#card-number").waitFor({ state: "visible", timeout: 8000 });
      this.cardFilled = true;
      for (const [sel, val] of [["#card-number", card.number], ["#expire-date", exp], ["#cvc", card.cvv]]) {
        const loc = fr.locator(sel);
        await loc.click();
        await loc.fill("");
        await loc.pressSequentially(val, { delay: 25 }); // 逐字輸入,讓表單的格式化腳本正常運作
      }
      const holder = page.locator("[name='credit_card[card_holder_name]']:visible").first();
      if (await holder.count()) await holder.fill(card.holder);
      const digits = (s) => s.replace(/\D/g, "");
      const ok =
        digits(await fr.locator("#card-number").inputValue()) === card.number &&
        digits(await fr.locator("#expire-date").inputValue()) === exp &&
        (await fr.locator("#cvc").inputValue()) === card.cvv;
      if (!ok) this.log("自動填卡後讀回的內容不符");
      return ok ? "filled" : "failed";
    } catch (e) {
      this.log("自動填卡失敗:", firstLine(e));
      return "failed";
    }
  }

  async _buy(order, t0) {
    const page = this.page;
    const fail = async (message) => {
      await this.discord(`**❌ 自動下單停止:${order.name}**\n${message}\n電腦上的 Chrome 停在這一頁,可以直接接手結帳。`, await this.shot());
      return { ok: false, message };
    };

    if (!page.url().startsWith(this.base)) await page.goto(this.base, { waitUntil: "domcontentloaded" });

    // 1) 加入購物車(同源 fetch,沿用登入 Cookie)
    const res = await page.evaluate(ADD_TO_CART_JS, { id: order.variantId, qty: order.qty });
    if (res.status !== 200) {
      await page.goto(`${this.base}/products/${order.slug}`, { waitUntil: "domcontentloaded" });
      await page.locator("button.addToCart").first().click({ timeout: 5000 });
      await page.waitForTimeout(1500);
    }

    // 2) 購物車 / 結帳頁
    await page.goto(this.base + "/cart", { waitUntil: "domcontentloaded" });
    if (await this.blocked()) return fail("結帳頁出現驗證(驗證碼 / Cloudflare),請在電腦上的 Chrome 手動完成");
    const checkoutBtn = page.locator("#checkout-button");
    try {
      await checkoutBtn.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      return fail("找不到結帳按鈕(可能未登入或網站改版)");
    }

    const rows = await page.locator(".delete-button:visible").count();
    if (rows !== 1 && order.live) return fail(`購物車內有 ${rows} 項商品(預期 1 項),為避免誤購沒有送出`);

    // 3) 付款 / 運送方式
    for (const [sel, kw] of [
      ["button[id^='payment-button']", order.payment_keyword],
      ["button[id*='shipping-button']", order.shipping_keyword],
    ]) {
      if (!kw) continue;
      const btn = page.locator(sel, { hasText: kw }).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(300);
      } else if (order.live && sel.includes("payment")) {
        return fail(`找不到付款方式「${kw}」,沒有送出`);
      }
    }

    // 4) 同意條款
    for (const sel of ["#allow-customer-terms-check-box", "#allow-shipping-terms-check-box"]) {
      const cb = page.locator(sel);
      if ((await cb.count()) && !(await cb.isChecked())) {
        try {
          await cb.check({ force: true, timeout: 2000 });
        } catch {
          await page.evaluate((s) => document.querySelector(s)?.click(), sel);
        }
      }
    }
    if (await this.blocked()) return fail("結帳頁出現驗證碼,請在電腦上的 Chrome 手動完成");

    // 5) 信用卡表單
    const iframe = page.locator("#cyberbizpay-main-iframe");
    let cardNote = "";
    if ((await iframe.count()) && (await iframe.first().isVisible().catch(() => false))) {
      const r = await this.fillCard(page);
      if (r === "nocard") return fail("付款需要信用卡,但沒有可用的 card.dat(請在 FunboxSniper「設定 / 更換信用卡」)");
      if (r === "failed") return fail("自動填入信用卡失敗或核對不符,沒有送出");
      cardNote = "信用卡已自動填入並核對無誤。";
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!order.live) {
      await this.discord(
        `**🧪 演練完成:${order.name}**\n已走到結帳頁(${secs} 秒),未送出訂單。${cardNote}\n購物車內留有演練商品,請到 Funbox 手動刪除。`,
        await this.shot(),
      );
      return { ok: true, message: `演練完成,結帳頁已就緒(${secs} 秒)。${cardNote}` };
    }

    // 6) 送出
    const startUrl = page.url();
    await checkoutBtn.click();
    for (let i = 0; i < 40 && page.url() === startUrl; i++) await page.waitForTimeout(500);
    const url = page.url();
    const png = await this.shot();

    if (!url.startsWith(this.base)) {
      // 導向銀行 3D 驗證頁:保留這個分頁給您完成,之後改用新分頁繼續監控
      this.page = await this.ctx.newPage();
      await this.discord(`**🔔 請立刻完成付款驗證:${order.name}**\n訂單已送出並導向銀行驗證頁。請到電腦上的 Chrome 輸入簡訊驗證碼(通常幾分鐘內就會逾時)。`, png);
      return { ok: true, message: "訂單已送出,等待您在電腦上的 Chrome 完成銀行簡訊驗證" };
    }
    if (!url.includes("/carts/") && !url.endsWith("/cart")) {
      await this.discord(`**✅ 訂單已送出:${order.name}**(${secs} 秒)`, png);
      return { ok: true, message: `訂單已送出(${secs} 秒)` };
    }
    const err = await page.evaluate(() =>
      [...document.querySelectorAll(".alert, .error, .has-error, .toast, [role=alert]")]
        .map((e) => e.innerText.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" | "),
    );
    await this.discord(`**❌ 送出後仍停在結帳頁:${order.name}**\n${err || "結帳頁無回應"}`, png);
    return { ok: false, message: `仍停留在結帳頁:${err || "未知原因"}` };
  }
}
