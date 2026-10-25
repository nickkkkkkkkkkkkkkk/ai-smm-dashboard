"""Add, remove or restore a tracked account from a GitHub issue.

The dashboard's Accounts menu opens a pre-filled issue titled
"[account] add @handle", "[account] remove @handle" or "[account] restore @handle".
.github/workflows/accounts.yml runs this on the repo owner's issues only.
"""
import json
import os
import re
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "accounts.json"


def say(msg):
    print(msg)
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as f:
        f.write(f"msg={msg}\n")


def main():
    m = re.match(r"\[account\]\s+(add|remove|restore)\s+@?([A-Za-z0-9._]{2,24})\s*$", os.environ.get("TITLE", "").strip(), re.I)
    if not m:
        say("Couldn't read that request. The title should look like: [account] add @handle")
        return
    action, handle = m.group(1).lower(), "@" + m.group(2)
    niche = ""
    nm = re.search(r"^niche:\s*(.+)$", os.environ.get("BODY") or "", re.M | re.I)
    if nm:
        niche = nm.group(1).strip()[:60]

    accounts = json.loads(DATA.read_text(encoding="utf-8"))
    rec = next((a for a in accounts if a["account"].lower() == handle.lower()), None)
    if rec:
        handle = rec["account"]
    if action == "add" and not rec:
        accounts.append({"platform": "tiktok", "account": handle, "niche": niche, "tracking": "active",
                         "last_update_status": "pending", "followers": 0, "following": 0,
                         "profile_likes": 0, "as_of": None, "avatar": ""})
        msg = f"Added {handle}. Stats fill in on the dashboard in about a minute."
    elif not rec:
        msg = f"{handle} isn't on the dashboard, so nothing changed."
    elif action == "remove":
        rec["tracking"] = "removed"
        msg = f"Removed {handle} from the dashboard. Its history is kept; restore it any time from the Accounts menu."
    else:
        rec["tracking"] = "active"
        if niche:
            rec["niche"] = niche
        msg = f"{handle} is tracked again."
    DATA.write_text(json.dumps(accounts, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    say(msg)


if __name__ == "__main__":
    main()
