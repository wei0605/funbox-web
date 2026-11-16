import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, sanitizeConfig } from "../src/config.js";
import { extractSlugs, looksBlocked, matches, prefixOk, slugOf } from "../src/parse.js";

const cfg = DEFAULT_CONFIG;

test("slugOf 處理網址、編碼與結尾斜線", () => {
  assert.equal(slugOf("https://shop.funbox.com.tw/products/BB09728"), "bb09728");
  assert.equal(slugOf("/products/bb09728/"), "bb09728");
  assert.equal(slugOf("bb09728"), "bb09728");
  assert.equal(slugOf("/products/%E6%88%B0"), "戰");
});

test("extractSlugs 抓出列表頁與 sitemap 的商品連結", () => {
  const html = `
    <a href="/products/bb09728?variant=1">A</a>
    <a href='https://shop.funbox.com.tw/products/bb08062'>B</a>
    <a href="/collections/all">no</a>
    <loc>https://shop.funbox.com.tw/products/toy-1</loc>`;
  assert.deepEqual([...extractSlugs(html)].sort(), ["bb08062", "bb09728", "toy-1"]);
});

test("matches:前綴、關鍵字與排除", () => {
  assert.ok(matches(cfg, { slug: "bb100", name: "隨便" }));
  assert.ok(matches(cfg, { slug: "x1", name: "BEYBLADE X 戰鬥陀螺" }));
  assert.ok(!matches(cfg, { slug: "x1", name: "樂高" }));
  assert.ok(!matches(cfg, { slug: "bb100", name: "戰鬥陀螺 APP兌換券" }));
  assert.ok(prefixOk(cfg, "bb1") && !prefixOk(cfg, "cc1"));
});

test("looksBlocked 辨識 Cloudflare 驗證頁", () => {
  const h = new Headers();
  assert.ok(looksBlocked({ headers: h }, "<title>Just a moment...</title>"));
  assert.ok(!looksBlocked({ headers: h }, "<title>Funbox</title>"));
  assert.ok(looksBlocked({ headers: new Headers({ "cf-mitigated": "challenge" }) }, ""));
});

test("sanitizeConfig 接受預設設定", () => {
  const { cfg: out, error } = sanitizeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(error, undefined);
  assert.equal(out.sources.length, 2);
});

test("sanitizeConfig 限制間隔範圍並拒絕外部網域", () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.sources[0].interval = 1;
  c.pending.interval = 0;
  const { cfg: out } = sanitizeConfig(c);
  assert.equal(out.sources[0].interval, 3);
  assert.equal(out.pending.interval, 2);

  c.sources[0].url = "https://evil.example.com/x";
  assert.match(sanitizeConfig(c).error, /網域/);
});

test("sanitizeConfig 拒絕空來源、重複名稱與非 https", () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.sources = [];
  assert.ok(sanitizeConfig(c).error);
  const d = structuredClone(DEFAULT_CONFIG);
  d.sources[1].name = d.sources[0].name;
  assert.match(sanitizeConfig(d).error, /重複/);
  const e = structuredClone(DEFAULT_CONFIG);
  e.base_url = "http://shop.funbox.com.tw";
  assert.ok(sanitizeConfig(e).error);
});

test("sanitizeConfig:自動下單設定預設關閉、數值有上下限", () => {
  const { cfg } = sanitizeConfig({ ...DEFAULT_CONFIG, buy: { enabled: true, live: "yes", keywords: [" 天馬 ", ""], quantity: 99, max_orders: 0 } });
  assert.equal(cfg.buy.enabled, true);
  assert.equal(cfg.buy.live, false); // 只有 true 才算正式下單
  assert.deepEqual(cfg.buy.keywords, ["天馬"]);
  assert.equal(cfg.buy.quantity, 20);
  assert.equal(cfg.buy.max_orders, 1);
  assert.equal(sanitizeConfig(DEFAULT_CONFIG).cfg.buy.enabled, false);
});
