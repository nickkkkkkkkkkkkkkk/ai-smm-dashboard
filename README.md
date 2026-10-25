# ai-smm-dashboard

Content HQ: a free dashboard for the TikTok accounts.

- `index.html` is the dashboard (served by GitHub Pages).
- `data/accounts.json` lists the tracked accounts. Add one by adding an entry with `platform`, `account` (`@handle`), `niche` and `tracking: "active"`; set `tracking` to `"removed"` to hide it but keep its history.
- `data/posts.json` lists every post with its public video URL, schedule and stats.
- `.github/workflows/update.yml` runs `scripts/update.py` every hour. It reads public TikTok pages (no logins) and commits fresh numbers. Use **Actions → Update stats → Run workflow** for a manual refresh.
- `src/worker.js` (Cloudflare) adds **Sign in with TikTok**: `/auth/tiktok/start` → TikTok → `/auth/tiktok/callback` stores the tokens in the `HQ` KV namespace, and a 10-minute cron pulls official follower and per-video stats, served to the page at `/api/tiktok`. It needs the Worker secrets `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` from a TikTok developer app whose Login Kit redirect URI is `https://ai-smm-dashboard.steep-shape-ea79.workers.dev/auth/tiktok/callback`.
