"""Refresh data/accounts.json and data/posts.json from public TikTok and YouTube pages.

Runs in GitHub Actions on a timer (see .github/workflows/update.yml).
Read-only: it only downloads public pages. If TikTok blocks a read, the
old numbers are kept and the account/post is marked with the failure.

Scheduled posts have no URL until they go live (TikTok Studio gives none), so
each run also lists the profile's videos and links new ones to the planned
post with the closest caption. Videos that match no planned post are added
as new posts, so the dashboard keeps up even if posts.json isn't updated.

YouTube Shorts are planned with their exact times, so a live Short is linked to
its planned post by title. Instagram has no public stats page we can read, so its
posts only flip to Live at their scheduled time (stats stay empty).
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
import xml.etree.ElementTree as ET_XML

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


def key(rec):
    return (rec.get("platform", "tiktok"), rec["account"])


def count(text):
    """'1.2K' -> 1200, '39' -> 39."""
    m = re.match(r"([\d.,]+)\s*([KMB]?)", text.strip(), re.I)
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    return int(n * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}[m.group(2).upper()])


def yt_channel(handle):
    """Subscriber count, channel id and avatar url from the public channel page."""
    html = requests.get(f"https://www.youtube.com/{handle}", headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
                        timeout=30).text
    cid = re.search(r'<meta itemprop="identifier" content="(UC[\w-]+)"', html)
    subs = re.search(r'"([\d.,]+[KMB]?) subscribers?"', html)
    if not cid:
        raise RuntimeError("channel data not found (blocked or layout changed)")
    av = re.search(r'<meta property="og:image" content="([^"]+)"', html)
    return {"channel_id": cid.group(1), "followers": count(subs.group(1)) if subs else 0,
            "avatar_url": av.group(1) if av else None}


def yt_videos(handle, channel_id):
    """Public Shorts with stats: the Shorts tab (views) plus the RSS feed (exact views, likes, post time)."""
    vids = {}
    out = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--flat-playlist", "--dump-json", "--no-warnings",
         f"https://www.youtube.com/{handle}/shorts"], capture_output=True, text=True, timeout=180)
    for line in out.stdout.splitlines():
        j = json.loads(line)
        vids[j["id"]] = {"title": j.get("title") or "", "timestamp": None,
                         "stats": {"views": int(j.get("view_count") or 0), "likes": 0, "comments": 0}}
    feed = requests.get(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}", headers={"User-Agent": UA}, timeout=30)
    if feed.ok:
        ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
              "m": "http://search.yahoo.com/mrss/"}
        for e in ET_XML.fromstring(feed.content).findall("a:entry", ns):
            vid = e.findtext("yt:videoId", namespaces=ns)
            v = vids.setdefault(vid, {"title": e.findtext("a:title", namespaces=ns) or "", "timestamp": None,
                                      "stats": {"views": 0, "likes": 0, "comments": 0}})
            v["timestamp"] = datetime.fromisoformat(e.findtext("a:published", namespaces=ns)).timestamp()
            st, rating = e.find("m:group/m:community/m:statistics", ns), e.find("m:group/m:community/m:starRating", ns)
            if st is not None:
                v["stats"]["views"] = max(v["stats"]["views"], int(st.get("views") or 0))
            if rating is not None:
                v["stats"]["likes"] = int(rating.get("count") or 0)
    for vid, v in vids.items():
        v["url"] = f"https://www.youtube.com/shorts/{vid}"
        v["thumb"] = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    if not vids and out.returncode != 0 and "does not have a shorts tab" not in out.stderr:
        raise RuntimeError((out.stderr.strip().splitlines() or ["no shorts listed"])[-1][:200])
    return vids


def link_youtube(account, vids, posts):
    """Give planned Shorts their URL by title; add any Short that isn't planned."""
    mine = [p for p in posts if key(p) == ("youtube", account)]
    known = {(p.get("url") or "").rsplit("/", 1)[-1] for p in mine if p.get("url")}
    for vid, v in sorted(vids.items(), key=lambda kv: kv[1]["timestamp"] or 0):
        if vid in known:
            continue
        best = max((p for p in mine if not p.get("url")), default=None,
                   key=lambda p: SequenceMatcher(None, words(p["title"]), words(v["title"])).ratio())
        if best and SequenceMatcher(None, words(best["title"]), words(v["title"])).ratio() >= 0.8:
            best["url"] = v["url"]
            print(f"youtube #{best['post']}: now live at {v['url']}")
        elif v["timestamp"]:  # only Shorts we can date; untimed ones are old uploads
            tags = re.findall(r"#\w+", v["title"].lower())
            mine.append({"platform": "youtube", "account": account, "post": max((p["post"] for p in mine), default=0) + 1,
                         "title": v["title"][:90] or "Untitled Short", "game": "", "caption_question": "",
                         "scheduled_at": datetime.fromtimestamp(v["timestamp"], ET).isoformat(), "status": "Live",
                         "views": 0, "likes": 0, "comments": 0, "url": v["url"],
                         "genre": next((GENRE_TAGS[t] for t in tags if t in GENRE_TAGS), "Other")})
            posts.append(mine[-1])
            print(f"youtube #{mine[-1]['post']}: added unplanned Short {v['url']}")


def save_avatar(a, url):
    img = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    if img.ok and img.content:
        name = a["account"].lstrip("@") + ("" if a.get("platform", "tiktok") == "tiktok" else "-" + a["platform"]) + ".jpg"
        (AVATARS / name).write_bytes(img.content)
        a["avatar"] = f"data/avatars/{name}"


def words(caption):
    """A caption without hashtags, "(fictional story)" or punctuation, for comparing."""
    c = re.sub(r"#\S+|\(fictional story\)", " ", caption or "", flags=re.I)
    return " ".join(re.sub(r"[^a-z0-9' ]", " ", c.lower()).split())


def link_new_videos(account, vids, posts, stories):
    """Give planned posts their URL once they go live, and add any video that isn't planned."""
    known = {m.group(1) for p in posts if (m := re.search(r"/video/(\d+)", p.get("url") or ""))}
    fresh = {i: v for i, v in vids.items() if i not in known}
    waiting = [p for p in posts if key(p) == ("tiktok", account) and not p.get("url")]
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
            "platform": "tiktok", "account": account,
            "post": max((p["post"] for p in posts if key(p) == ("tiktok", account)), default=0) + 1,
            "title": title[:90] or "Untitled video", "game": "", "caption_question": "",
            "scheduled_at": datetime.fromtimestamp(v["timestamp"] or 0, ET).isoformat(), "status": "Live",
            "views": 0, "likes": 0, "comments": 0, "url": v["url"],
            "genre": next((GENRE_TAGS[t] for t in tags if t in GENRE_TAGS), "Other"),
        })
        print(f"#{posts[-1]['post']}: added unplanned video {v['url']}")


def save_thumb(url, thumb):
    """Keep one cover image per video at data/thumbs/<video id>.jpg (TikTok's own links expire)."""
    m = re.search(r"/(?:video|shorts)/([\w-]+)", url)
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
    listed = {}  # (platform, video id) -> stats from the profile listings
    AVATARS.mkdir(parents=True, exist_ok=True)
    stamp = now_iso()

    for a in accounts:
        plat = a.get("platform", "tiktok")
        if a.get("tracking") == "removed" or plat not in ("tiktok", "youtube"):
            continue
        try:
            if plat == "tiktok":
                p = profile(a["account"])
                a.update({k: p[k] for k in ("followers", "following", "profile_likes")})
            else:
                p = yt_channel(a["account"])
                a.update({"followers": p["followers"], "channel_id": p["channel_id"]})
            if p["avatar_url"]:
                save_avatar(a, p["avatar_url"])
            a["last_update_status"] = "ok"
            a["as_of"] = stamp
            a.pop("last_error", None)
            print(f"{plat} {a['account']}: {p['followers']} followers")
        except Exception as e:  # keep old numbers
            a["last_update_status"] = "blocked"
            a["last_error"] = str(e)[:200]
            print(f"{plat} {a['account']}: profile read failed: {e}")
        try:
            if plat == "tiktok":
                vids = profile_videos(a["account"])
                link_new_videos(a["account"], vids, posts, stories)
            else:
                vids = yt_videos(a["account"], a["channel_id"]) if a.get("channel_id") else {}
                link_youtube(a["account"], vids, posts)
            listed.update({(plat, i): v for i, v in vids.items()})
        except Exception as e:  # posts with a URL are still read one by one below
            print(f"{plat} {a['account']}: video list failed: {e}")

    tracked = {key(a) for a in accounts if a.get("tracking") != "removed"}
    now = datetime.now(timezone.utc)
    for p in posts:
        if key(p) not in tracked:
            continue
        plat = p.get("platform", "tiktok")
        started = p.get("scheduled_at") and datetime.fromisoformat(p["scheduled_at"]) <= now
        if plat == "instagram":  # no stats source yet: live once its time has passed
            p["status"] = "Live" if started else "Scheduled"
            continue
        if not (p.get("url") and started):
            p["status"] = "Scheduled"
            continue
        try:
            vid = re.search(r"/(?:video|shorts)/([\w-]+)", p["url"]).group(1)
            v = listed.get((plat, vid))
            if not v and plat == "youtube":
                raise RuntimeError("not in the channel's Shorts list")
            stats, thumb = (v["stats"], v["thumb"]) if v else video(p["url"])
            p.update(stats)
            try:
                save_thumb(p["url"], thumb)
            except Exception as e:
                print(f"#{p['post']}: thumbnail failed: {e}")
            p["status"] = "Live"
            p["as_of"] = stamp
            p.pop("last_error", None)
            print(f"{plat} #{p['post']}: {p['views']} views")
        except Exception as e:
            p["status"] = "Live"
            p["last_error"] = str(e)[:200]
            print(f"{plat} #{p['post']}: read failed: {e}")

    save("accounts.json", accounts)
    save("posts.json", posts)
    save("stories.json", stories)
    save("meta.json", {"updated_at": stamp})


if __name__ == "__main__":
    main()
