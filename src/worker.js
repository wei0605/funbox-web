// 入口:驗證 → 轉給 Durable Object;其餘由靜態資源(PWA)提供。
import { Monitor } from "./monitor.js";

export { Monitor };

const enc = new TextEncoder();

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** 比對雜湊值,避免時間差攻擊。 */
async function sameSecret(given, expected) {
  if (!expected || expected.length < 16) return false; // 未設定或太短一律拒絕
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** 回傳 "admin"(手機控制台)、"poller"(電腦上的偵測程式,只能回報)或 null。 */
async function whoIs(request, env) {
  const auth = request.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!given) return null;
  if (await sameSecret(given, env.ADMIN_TOKEN)) return "admin";
  if (await sameSecret(given, env.POLLER_TOKEN)) return "poller";
  return null;
}

const jsonResp = (data, status) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const monitorStub = (env) => env.MONITOR.get(env.MONITOR.idFromName("main"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const who = await whoIs(request, env);
    if (!who) return jsonResp({ error: "unauthorized" }, 401);
    if (who === "poller" && !(request.method === "POST" && url.pathname === "/api/report")) {
      return jsonResp({ error: "forbidden" }, 403);
    }
    // /api/xxx → DO 內的 /xxx(只轉送白名單方法,避免任意請求進到 DO)
    if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
      return jsonResp({ error: "method not allowed" }, 405);
    }
    const inner = new URL(request.url);
    inner.pathname = url.pathname.slice("/api".length);
    return monitorStub(env).fetch(new Request(inner, request));
  },
};
