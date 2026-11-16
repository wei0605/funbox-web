# Funbox 監控(網頁版 / iPhone PWA)

定時掃描 Funbox 新品與補貨,**發現時推播 Discord**,並提供 iPhone 可安裝的控制台(開始/停止、完整設定、日誌、手動追蹤)。

- 不需要自己的電腦或主機,**不儲存任何信用卡資料**。
- 結帳由您收到通知後,在已登入的 Safari 完成。
- 邏輯移植自 `../funbox-sniper` 的「僅通知」模式。

## 架構

```
GitHub Actions (每 5 分鐘)            Cloudflare Worker + Durable Object          您的 iPhone
 poller/run.mjs  ── 抓 Funbox 網頁 ─▶  /api/ingest*  比對新品、判斷庫存  ──▶  Discord 通知
                                       保存狀態、提供控制台 API  ◀── PWA 控制台(設定 / 開關 / 日誌)
```

**為什麼要分兩段**:Funbox 會對 Cloudflare Workers 回 `403 Forbidden`(實測過,與標頭無關),所以「抓網頁」改在 GitHub Actions 跑,Worker 只負責判斷、保存狀態與通知。

## 部署

### 1. Worker(已部署的話可略過)

```powershell
npm install
npx wrangler login               # 或設定 CLOUDFLARE_API_TOKEN 環境變數
npx wrangler secret put ADMIN_TOKEN       # 控制台密碼與輪詢程式共用,至少 16 字元
npx wrangler secret put DISCORD_WEBHOOK   # Discord Webhook
npx wrangler deploy
```

### 2. GitHub Actions 輪詢

1. 把這個資料夾發佈成 GitHub 專案(**需為 Public**:私人專案的免費 Actions 額度每月只有 2000 分鐘,每 5 分鐘一次會超過;專案內沒有任何密碼,密碼放在 Secrets)。
2. 專案頁 → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name:`ADMIN_TOKEN`
   - Secret:與 Worker 相同的 ADMIN_TOKEN
3. 如果換了 Worker 網址,修改 `.github/workflows/poll.yml` 裡的 `WORKER_URL`。
4. **Actions** 頁 → 左側 `poll-funbox` → **Run workflow** 先手動跑一次確認成功。之後每 5 分鐘自動執行。

## 安裝到 iPhone

1. 用 **Safari** 開啟 Worker 網址,輸入 ADMIN_TOKEN 登入。
2. 分享 → **加入主畫面**。
3. 設定頁按 **傳送 Discord 測試通知**,確認手機有收到。
4. 監控頁按 **開始監控**。第一次輪詢只建立基準(既有商品不通知)。

## 運作方式

- 輪詢程式抓商品列表 → 回報 Worker → Worker 找出新出現的商品網址 → 請輪詢程式抓商品頁 → 判斷。
- 符合條件且有貨 → 通知;缺貨或頁面未開放 → 通知一次並進入追蹤清單,有貨時再通知。
- 追蹤逾時(預設 120 分鐘)自動放棄。可在控制台貼商品網址手動追蹤。
- 控制台在超過 15 分鐘沒收到輪詢回報時會顯示警示。

## 限制(請務必了解)

- **偵測延遲**:GitHub Actions 排程最短 5 分鐘一次,而且**實際執行常延遲數分鐘**,偶爾會跳過。熱門陀螺開賣後幾分鐘內就可能售完,**這個方案可能來不及**。想要秒級偵測,需改在常駐環境(例如家裡小主機)執行同一支 `poller/run.mjs` 並設定 `POLL_LOOP_SECONDS`。
- **GitHub 條款**:不建議用 Actions 長時間連續迴圈輪詢(可能違反使用條款)。本專案預設每次只跑一輪。
- 公開專案若 60 天沒有任何提交,GitHub 會自動停用排程,需到 Actions 頁手動重新啟用。
- **GitHub 的 IP 能否讀到 Funbox**:已實測本機與另一個雲端服務可讀,但 GitHub Actions 的機器未實測;首次執行請看 Actions 日誌或控制台來源狀態。
- **購物車連結**:預設通知只附商品頁連結。設定頁可填購物車連結範本(例 `{base}/cart/{variant_id}:{qty}`),**此格式尚未驗證**。
- 本程式只負責偵測與通知;付款請自己在 Safari 完成。

## 本機開發與測試

```powershell
npm run dev      # http://localhost:8787(.dev.vars 放 ADMIN_TOKEN)
npm test         # 解析與設定檢查的單元測試

# 對本機 Worker 手動跑一輪輪詢
$env:WORKER_URL="http://localhost:8787"; $env:ADMIN_TOKEN="local-dev-token-1234567890"; node poller/run.mjs
```
