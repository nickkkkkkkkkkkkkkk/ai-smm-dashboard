# ai-smm-dashboard

Content HQ: a free dashboard for the TikTok accounts.

- `index.html` is the dashboard (served by GitHub Pages).
- `data/accounts.json` lists the tracked accounts. Add one by adding an entry with `platform`, `account` (`@handle`), `niche` and `tracking: "active"`; set `tracking` to `"removed"` to hide it but keep its history.
- `data/posts.json` lists every post with its public video URL, schedule and stats.
- `.github/workflows/update.yml` runs `scripts/update.py` every hour. It reads public TikTok pages (no logins) and commits fresh numbers. Use **Actions → Update stats → Run workflow** for a manual refresh.
