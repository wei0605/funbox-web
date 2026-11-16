# Funbox 監控 + 自動下單(Cloudflare 控制台 + 家裡電腦執行)

| 部分 | 跑在哪 | 做什麼 |
|---|---|---|
| 控制台 + 大腦(`src/`、`public/`) | Cloudflare Worker | 手機控制台、設定、判斷新品 / 補貨、Discord 通知、決定要不要下單 |
| 偵測 + 下單(`poller/`) | 家裡電腦 | 每 10 秒抓 Funbox 網頁回報給 Worker;收到下單指示就用 FunboxSniper 的專屬 Chrome 加入購物車、自動填信用卡、送出 |

Funbox 會擋 Cloudflare Workers,所以抓網頁和下單改在您的電腦執行。GitHub 只當作私人的程式碼備份,不執行任何東西。

---

## 一、更新 Cloudflare Worker(做一次)

PowerShell:

```powershell
cd "D:\Website and PWA\funbox-web"

# 產生一組隨機字串當 POLLER_TOKEN(電腦程式回報用,和手機登入密碼分開)
[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }) -as [byte[]])

npx wrangler secret put POLLER_TOKEN     # 貼上剛剛的字串
npx wrangler deploy
```

## 二、準備 FunboxSniper 的 Chrome 與信用卡(做一次)

1. 開 `funbox-sniper\release_new\FunboxSniper.exe`。
2. 按 **登入會員**,在跳出的 Chrome 登入 Funbox。
3. 設定頁 → **設定 / 更換信用卡**,輸入卡號、有效期限、CVV、持卡人英文姓名(加密存成 `card.dat`,只有您的 Windows 帳號能解開)。
4. 之後**不要**在 FunboxSniper 按「開始監控」,避免兩支程式同時下單。可以關掉 FunboxSniper,Chrome 視窗留著或關掉都可以(程式會自動用同一個設定檔開啟)。

## 三、設定電腦上的程式(做一次)

1. 把 `poller\local.env.example` 複製一份,改名為 `poller\local.env`。
2. 用記事本打開,填入 `POLLER_TOKEN`(第一步的字串)。其他欄位已填好預設值;`DISCORD_WEBHOOK` 選填,用來傳結帳截圖。
3. 雙擊 **`start-monitor.bat`**。第一次會自動安裝元件,之後會一直執行(當掉會自動重啟)。**關閉視窗就停止監控。**

## 四、開始監控

手機控制台 →「監控」頁按 **開始監控**。「電腦偵測程式」應顯示 **上線中**,自動下單顯示「已登入 Funbox 會員,信用卡 末四碼 xxxx」。

## 五、自動下單

1. **先演練一次**(挑一個目前有貨的商品,走到結帳頁並填好信用卡就停,絕不送出):
   ```powershell
   cd "D:\Website and PWA\funbox-web"
   node poller/run.mjs --test-buy bb09728
   ```
   演練會在購物車留下商品,**請到 Funbox 手動刪除**,否則正式下單會因為購物車不是 1 項而停下。
2. 控制台 → 設定 →「自動下單」:勾「啟用」,填 **下單關鍵字**(商品名稱含任一個才下單),付款方式文字預設「信用卡」。先不勾「正式送出」跑一陣子,確認沒問題再勾。
3. 正式下單送出後會導向銀行驗證頁,Discord 會通知 **「請立刻完成付款驗證」**:請到**電腦上的 Chrome** 輸入簡訊驗證碼(通常幾分鐘內就會逾時,所以下單時段人最好在電腦旁)。

### 會收到的 Discord 通知

- 🆕 發現新陀螺網址(頁面尚未開放)/ 新陀螺上架(缺貨,持續追蹤)
- 🔥 新陀螺上架(有貨)/ 補貨、開賣了
- 🛒 開始自動下單 → ✅ 訂單已送出 / 🔔 請完成付款驗證 / ❌ 下單失敗(請手動結帳)
- ⚠ 電腦程式異常、登入失效

### 安全設計

- 要同時「啟用」+「有關鍵字」+「正式送出」才會真的送出;正式下單有張數上限(預設 1 張),同一商品不會重複下單。
- 購物車不是剛好 1 項、找不到付款方式、沒有信用卡資料、填卡核對不符、出現驗證碼 → 不送出,通知您手動結帳(Chrome 會停在那一頁)。
- 填入卡號後不截圖;卡號不會出現在日誌或通知。

## 用 GitHub Desktop 備份(私人)

GitHub Desktop → File → Add local repository → 選 `funbox-web` → Commit → **Publish repository 時保持勾選「Keep this code private」**。
`poller\local.env`、`.dev.vars` 已被 `.gitignore` 排除,不會上傳。

## 注意事項

- 電腦要保持開機、不能睡眠(Windows 設定 → 電源 → 睡眠設為「永不」),網路要通。
- Funbox 會員登入失效時 Discord 會通知,到專屬 Chrome 重新登入即可。
- 網站改版(按鈕、欄位變動)時要調整 `poller/checkout.mjs` 的選擇器。
- 請遵守網站使用條款,輪詢間隔不要調太短。
