# Funbox 雲端監控

定時掃描新品與補貨並透過 Discord 推播通知，提供手機 PWA 控制台。所有金鑰與網址皆儲存在平台加密 Secrets，程式碼不含任何敏感資訊。

## GitHub Actions 設定

於 GitHub 專案 **Settings → Secrets and variables → Actions → New repository secret** 新增：

- `WORKER_URL`：您的 Cloudflare Worker 網址
- `POLLER_TOKEN`：與 Worker 相同的回報金鑰

設定完成後，至 **Actions → poll-funbox → Run workflow** 手動測試一次即可。
