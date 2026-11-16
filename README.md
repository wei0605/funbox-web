# Funbox 雲端監控 (GitHub Actions + Cloudflare 控制台 + Discord 推播)

電腦不用開機、雲端完全不儲存任何信用卡資料。偵測到新品或補貨立刻發 Discord 通知到 iPhone，點開商品連結在已登入的 Safari 結帳即可。

| 角色 | 跑在哪裡 | 做什麼 |
|---|---|---|
| **抓網頁** (`.github/workflows/poll.yml` + `poller/run.mjs`) | **GitHub Actions** (每 5 分鐘排程) | 抓取 Funbox 商品列表與待補貨頁面，回報給 Worker |
| **控制台 + 大腦** (`src/`、`public/`) | **Cloudflare Worker** | iPhone PWA 控制台、保存已知商品狀態、判斷新品/補貨、發送 Discord 推播 |

---

## 一、設定 GitHub Actions 雲端排程（只需做一次）

1. **將 GitHub 專案設為 Public（公開）**
   - 為什麼：私人專案每月免費額度只有 2,000 分鐘（每 5 分鐘跑一次約 7 天會用完）；**公開專案完全免費無上限**。程式碼內不含任何密碼或個資，密碼只存在加密的 GitHub Secrets。
   - 做法：打開 `https://github.com/wei0605/funbox-web/settings` → 拉到最下方 **Danger Zone** → **Change repository visibility** → 改為 **Public**。

2. **新增 GitHub Secret（讓 GitHub Actions 能回報給您的 Worker）**
   - 打開 `https://github.com/wei0605/funbox-web/settings/secrets/actions`
   - 點 **New repository secret**：
     - **Name**：`POLLER_TOKEN`
     - **Secret**：填入與 Worker 相同的 `POLLER_TOKEN`
   - 點 **Add secret**。

3. **用 GitHub Desktop 推送更新**
   - 打開 **GitHub Desktop**，確認切到 `funbox-web`，左側會看到新增的 `.github/workflows/poll.yml` 等變更。
   - 左下角 Summary 隨意填（例如 `啟用 GitHub Actions 雲端排程`）→ 點 **Commit to main** → 點右上角 **Push origin**。

4. **手動測試跑一次**
   - 打開 `https://github.com/wei0605/funbox-web/actions`（若出現綠色按鈕詢問是否啟用 Workflows，點 **I understand my workflows, go ahead and enable them**）。
   - 點左側 **poll-funbox** → 右側點 **Run workflow** → 綠色 **Run workflow**。
   - 等約 15～20 秒變成綠色勾勾 ✅，回到手機控制台就會看到「GitHub Actions · 運作正常」與商品數量！

---

## 二、iPhone 安裝控制台

1. 用 iPhone **Safari** 開啟 `https://funbox-watch.s1688334.workers.dev`，輸入管理密碼（`ADMIN_TOKEN`）登入。
2. 點底部分享按鈕 → **加入主畫面**。
3. 在「監控」頁確認為 **▶ 開始監控（監控中）**。第一次掃描只建立基準（既有商品不通知），之後出現的新品或補貨就會推播到 Discord。

---

## 三、注意事項與進階選項

- **排程頻率**：GitHub Actions 最短排程為每 5 分鐘一次（尖峰時段可能延遲數分鐘）；公開專案若連續 60 天沒有 commit，GitHub 會暫停排程，到 Actions 頁面點一下 Enable 即可恢復。
- **開賣時段想加速到秒級掃描（選用）**：若遇到熱門陀螺準點開賣、電腦剛好有開，仍可雙擊本機的 `start-monitor.bat`，會自動以每 3～10 秒的速度掃描，關掉視窗後繼續由 GitHub Actions 接手。
