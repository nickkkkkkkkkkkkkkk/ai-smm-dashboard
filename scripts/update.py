"""Refresh data/accounts.json and data/posts.json from public TikTok pages.

Runs in GitHub Actions on a timer (see .github/workflows/update.yml).
Read-only: it only downloads public pages. If TikTok blocks a read, the
old numbers are kept and the account/post is marked with the failure.

Scheduled posts have no URL until they go live (TikTok Studio gives none), so
each run also lists the profile's videos and links new ones to the planned
post with the closest caption. Videos that match no planned post are added
as new posts, so the dashboard keeps up even if posts.json isn't updated.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
AVATARS = DATA / "avatars"
THUMBS = DATA / "thumbs"
ET = ZoneInfo("America/New_York")
GENRE_TAGS = {"#horror": "Horror", "#revenge": "Revenge", "#funny": "Funny", "#wholesome": "Wholesome"}
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
        [sys.executable, "-m", "yt_dlp", "--impersonate", "chrome", "--dump-json", "--skip-download", "--no-warnings", url],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError((out.stderr.strip().splitlines() or ["yt-dlp failed"])[-1][:200])
    j = json.loads(out.stdout)
    stats = {k: int(j.get(src) or 0) for k, src in
             (("views", "view_count"), ("likes", "like_count"), ("comments", "comment_count"))}
    return stats, j.get("thumbnail")


def profile_videos(handle):
    """Every public video on a profile (newest first) with caption, post time and stats, via yt-dlp."""
    out = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--impersonate", "chrome", "--flat-playlist", "--dump-json", "--no-warnings",
         f"https://www.tiktok.com/@{handle.lstrip('@')}"],
        capture_output=True, text=True, timeout=180)
    vids = {}
    for line in out.stdout.splitlines():
        j = json.loads(line)
        thumb = next((t["url"] for t in j.get("thumbnails") or [] if t.get("id") == "cover"), None)
        vids[j["id"]] = {
            "url": f"https://www.tiktok.com/@{handle.lstrip('@')}/video/{j['id']}",
            "caption": j.get("description") or j.get("title") or "",
            "timestamp": j.get("timestamp"),
            "stats": {k: int(j.get(src) or 0) for k, src in
                      (("views", "view_count"), ("likes", "like_count"), ("comments", "comment_count"))},
            "thumb": thumb,
        }
    if not vids:
        raise RuntimeError((out.stderr.strip().splitlines() or ["no videos listed"])[-1][:200])
    return vids


def words(caption):
    """A caption without hashtags, "(fictional story)" or punctuation, for comparing."""
    c = re.sub(r"#\S+|\(fictional story\)", " ", caption or "", flags=re.I)
    return " ".join(re.sub(r"[^a-z0-9' ]", " ", c.lower()).split())


def link_new_videos(account, vids, posts, stories):
    """Give planned posts their URL once they go live, and add any video that isn't planned."""
    known = {m.group(1) for p in posts if (m := re.search(r"/video/(\d+)", p.get("url") or ""))}
    fresh = {i: v for i, v in vids.items() if i not in known}
    waiting = [p for p in posts if p["account"] == account and not p.get("url")]
    pairs = []
    for i, v in fresh.items():
        tags = set(re.findall(r"#\w+", v["caption"].lower()))
        for p in waiting:
            score = SequenceMatcher(None, words(p.get("caption_question")), words(v["caption"])).ratio()
            if p.get("game_tag") and p["game_tag"].lower() in tags:
                score += 0.15
            pairs.append((score, i, p["post"]))
    used_v, used_p = set(), set()
    for score, i, n in sorted(pairs, reverse=True):
        if score < 0.6 or i in used_v or n in used_p:
            continue
        used_v.add(i); used_p.add(n)
        p = next(p for p in waiting if p["post"] == n)
        p["url"] = fresh[i]["url"]
        if fresh[i]["timestamp"]:
            p["scheduled_at"] = datetime.fromtimestamp(fresh[i]["timestamp"], ET).isoformat()
        for s in stories:
            if s["account"] == account and s["post"] == n and not s.get("url"):
                s["url"] = p["url"]
        print(f"#{n}: now live at {p['url']} (caption match {score:.2f})")
    # Oldest first, so unplanned videos are numbered in posting order.
    for i, v in sorted(fresh.items(), key=lambda kv: kv[1]["timestamp"] or 0):
        if i in used_v:
            continue
        tags = re.findall(r"#\w+", v["caption"].lower())
        title = re.sub(r"\s+", " ", re.sub(r"#\S+|\(fictional story\)", " ", v["caption"], flags=re.I)).strip()
        posts.append({
            "platform": "tiktok", "account": account, "post": max((p["post"] for p in posts), default=0) + 1,
            "title": title[:90] or "Untitled video", "game": "", "caption_question": "",
            "scheduled_at": datetime.fromtimestamp(v["timestamp"] or 0, ET).isoformat(), "status": "Live",
            "views": 0, "likes": 0, "comments": 0, "url": v["url"],
            "genre": next((GENRE_TAGS[t] for t in tags if t in GENRE_TAGS), "Other"),
        })
        print(f"#{posts[-1]['post']}: added unplanned video {v['url']}")


def save_thumb(url, thumb):
    """Keep one cover image per video at data/thumbs/<video id>.jpg (TikTok's own links expire)."""
    m = re.search(r"/video/(\d+)", url)
    if not m or not thumb:
        return
    path = THUMBS / f"{m.group(1)}.jpg"
    if path.exists():
        return
    img = requests.get(thumb, headers={"User-Agent": UA}, timeout=30)
    if img.ok and img.content:
        THUMBS.mkdir(parents=True, exist_ok=True)
        path.write_bytes(img.content)


def main():
    accounts = load("accounts.json")
    posts = load("posts.json")
    stories = load("stories.json")
    listed = {}
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
        try:
            vids = profile_videos(a["account"])
            listed.update(vids)
            link_new_videos(a["account"], vids, posts, stories)
        except Exception as e:  # posts with a URL are still read one by one below
            print(f"{a['account']}: video list failed: {e}")

    tracked = {a["account"] for a in accounts if a.get("tracking") != "removed"}
    now = datetime.now(timezone.utc)
    for p in posts:
        if p["account"] not in tracked:
            continue
        due = p.get("url") and p.get("scheduled_at") and datetime.fromisoformat(p["scheduled_at"]) <= now
        if not due:
            p["status"] = "Scheduled"
            continue
        try:
            v = listed.get(re.search(r"/video/(\d+)", p["url"]).group(1))
            stats, thumb = (v["stats"], v["thumb"]) if v else video(p["url"])
            p.update(stats)
            try:
                save_thumb(p["url"], thumb)
            except Exception as e:
                print(f"#{p['post']}: thumbnail failed: {e}")
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
    save("stories.json", stories)
    save("meta.json", {"updated_at": stamp})


if __name__ == "__main__":
    main()
