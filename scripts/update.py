"""Refresh data/accounts.json and data/posts.json from public TikTok pages.

Runs in GitHub Actions on a timer (see .github/workflows/update.yml).
Read-only: it only downloads public pages. If TikTok blocks a read, the
old numbers are kept and the account/post is marked with the failure.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
AVATARS = DATA / "avatars"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name, obj):
    (DATA / name).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def profile(handle):
    """Followers, following, likes and avatar url from the public profile page."""
    url = f"https://www.tiktok.com/@{handle.lstrip('@')}"
    html = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}, timeout=30).text
    m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("profile data not found (blocked or layout changed)")
    info = json.loads(m.group(1))["__DEFAULT_SCOPE__"]["webapp.user-detail"]["userInfo"]
    stats = info.get("statsV2") or info["stats"]
    user = info["user"]
    return {
        "followers": int(stats["followerCount"]),
        "following": int(stats["followingCount"]),
        "profile_likes": int(stats.get("heartCount") or stats.get("heart") or 0),
        "avatar_url": user.get("avatarMedium") or user.get("avatarThumb"),
    }


def video(url):
    """Views, likes and comments for one public video via yt-dlp."""
    out = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--dump-json", "--skip-download", "--no-warnings", url],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError((out.stderr.strip().splitlines() or ["yt-dlp failed"])[-1][:200])
    j = json.loads(out.stdout)
    return {k: int(j.get(src) or 0) for k, src in
            (("views", "view_count"), ("likes", "like_count"), ("comments", "comment_count"))}


def main():
    accounts = load("accounts.json")
    posts = load("posts.json")
    AVATARS.mkdir(parents=True, exist_ok=True)
    stamp = now_iso()

    for a in accounts:
        if a.get("tracking") == "removed" or a.get("platform") != "tiktok":
            continue
        try:
            p = profile(a["account"])
            a.update({k: p[k] for k in ("followers", "following", "profile_likes")})
            if p["avatar_url"]:
                img = requests.get(p["avatar_url"], headers={"User-Agent": UA}, timeout=30)
                if img.ok and img.content:
                    name = a["account"].lstrip("@") + ".jpg"
                    (AVATARS / name).write_bytes(img.content)
                    a["avatar"] = f"data/avatars/{name}"
            a["last_update_status"] = "ok"
            a["as_of"] = stamp
            print(f"{a['account']}: {p['followers']} followers")
        except Exception as e:  # keep old numbers
            a["last_update_status"] = "blocked"
            a["last_error"] = str(e)[:200]
            print(f"{a['account']}: profile read failed: {e}")

    tracked = {a["account"] for a in accounts if a.get("tracking") != "removed"}
    now = datetime.now(timezone.utc)
    for p in posts:
        if p["account"] not in tracked:
            continue
        due = datetime.fromisoformat(p["scheduled_at"]) <= now
        if not due:
            p["status"] = "Scheduled"
            continue
        try:
            p.update(video(p["url"]))
            p["status"] = "Live"
            p["as_of"] = stamp
            p.pop("last_error", None)
            print(f"#{p['post']}: {p['views']} views")
        except Exception as e:
            p["status"] = "Live"
            p["last_error"] = str(e)[:200]
            print(f"#{p['post']}: read failed: {e}")

    save("accounts.json", accounts)
    save("posts.json", posts)
    save("meta.json", {"updated_at": stamp})


if __name__ == "__main__":
    main()
