#!/usr/bin/env python3
"""Turn stories.json into vertical split-screen story videos.

Top half: lightly blurred gameplay with a slow push-in, a title card that slides in
and leaves after ~1.5s (v4: retention data showed swipes at 0:01-0:02 while the
static card was up), pop-in word-by-word captions. A progress bar runs along the split line.
Bottom half: Roblox gameplay (random clip from gameplay/). Clip names listed in
gameplay/avoid.txt are skipped (e.g. footage with giveaway or link text on screen).
Voice: Kokoro (free, offline).

Usage: python make_videos.py [stories.json] [--only ID] [--min-sec 62]
"""
import argparse, json, os, random, re, subprocess, textwrap
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ROOT = HERE.parent
MODELS = ROOT / "tts" / "models"
FONTS = HERE / "fonts"
W, H, HALF, FPS, SR = 1080, 1920, 960, 30, 24000
GAP = 0.12  # silence between sentences, seconds
CARD_MIN, CARD_MAX = 1.0, 1.6  # title card is a flash, not a hold: viewers swiped while it sat still
CARD_IN = 0.15  # slide-in time for the card
ZOOM = 0.06  # top half pushes in by 6% over the video so it never looks static
SPEED, MIN_SPEED = 1.18, 1.06  # fast narration keeps retention; never drag below MIN_SPEED
TAIL = 0.3  # short tail so the loop back to the start feels seamless
BAR_H = 10
WORDS_PER_CHUNK = 3
CARD_FONT = r"C:\Windows\Fonts\arialbd.ttf"
if not os.path.exists(CARD_FONT):  # cloud test renders
    CARD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.?!])\s+", text) if s.strip()]


def tts(kokoro, story, speed):
    """Return (audio, words) where words = [(word, start, end)]."""
    chunks, words, t = [], [], 0.0
    gap = np.zeros(int(GAP * SR), dtype=np.float32)
    for sent in sentences(story["text"]):
        audio, _ = kokoro.create(sent, voice=story["voice"], speed=speed, lang="en-us")
        dur = len(audio) / SR
        toks = sent.split()
        weights = [len(w) + 2 for w in toks]
        total, acc = sum(weights), 0.0
        for w, wt in zip(toks, weights):
            start = t + dur * acc / total
            acc += wt
            words.append((w, start, t + dur * acc / total))
        chunks += [audio, gap]
        t += dur + GAP
    return np.concatenate(chunks), words


def ass_time(s):
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{sec:05.2f}"


def write_ass(words, path):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Anton,118,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,9,4,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for i in range(0, len(words), WORDS_PER_CHUNK):
        chunk = words[i:i + WORDS_PER_CHUNK]
        for j, (_, ws, we) in enumerate(chunk):
            end = chunk[j + 1][1] if j + 1 < len(chunk) else we
            parts = []
            for k, (w, _, _) in enumerate(chunk):
                w = w.upper().replace("{", "").replace("}", "")
                parts.append(r"{\c&H00E5FF&}" + w + r"{\c&HFFFFFF&}" if k == j else w)
            # Each new chunk pops in from 80% scale; later words in the chunk just change colour.
            pop = r"\fscx80\fscy80\t(0,90,\fscx100\fscy100)" if j == 0 else ""
            text = r"{\pos(540,640)" + pop + "}" + " ".join(parts)
            lines.append(f"Dialogue: 0,{ass_time(ws)},{ass_time(end)},Cap,,0,0,0,,{text}")
    path.write_text(head + "\n".join(lines) + "\n", encoding="utf-8")


def title_card(title, path):
    img = Image.new("RGBA", (W, HALF), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(CARD_FONT, 76)
    small = ImageFont.truetype(CARD_FONT, 40)
    lines = textwrap.wrap(title, 21)
    box_h = 150 + 96 * len(lines)
    x0, y0 = 70, 90
    d.rounded_rectangle([x0, y0, W - x0, y0 + box_h], 36, fill=(255, 255, 255, 245))
    d.ellipse([x0 + 40, y0 + 34, x0 + 110, y0 + 104], fill=(226, 35, 26, 255))
    d.text((x0 + 130, y0 + 48), "Roblox Story Time", font=small, fill=(30, 30, 30, 255))
    for i, line in enumerate(lines):
        d.text((x0 + 40, y0 + 130 + 96 * i), line, font=font, fill=(10, 10, 10, 255))
    img.save(path)


def probe_dur(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                   "-of", "csv=p=0", str(path)])
    return float(out)


def render(story, kokoro, gameplay, outdir, min_sec):
    work = outdir / "work" / story["id"]
    work.mkdir(parents=True, exist_ok=True)
    speed = SPEED
    audio, words = tts(kokoro, story, speed)
    # Creator Rewards only pays for videos over 1 minute: slow down a little if short.
    while len(audio) / SR < min_sec and speed > MIN_SPEED:
        speed -= 0.04
        audio, words = tts(kokoro, story, speed)
    if len(audio) / SR < min_sec:
        print(f"WARNING {story['id']}: only {len(audio) / SR:.1f}s at speed {speed:.2f}; add a few lines to the story")
    dur = len(audio) / SR + TAIL
    first = len(sentences(story["text"])[0].split())
    card_sec = min(CARD_MAX, max(CARD_MIN, words[first - 1][2] + 0.3))
    sf.write(work / "voice.wav", audio, SR)
    write_ass(words, work / "caps.ass")
    title_card(story["title"], work / "card.png")

    clip = random.choice(gameplay)
    start = random.uniform(0, max(0.0, probe_dur(clip) - dur - 1))
    # ffmpeg runs in the work dir so the ass filter gets relative paths (no drive-colon escaping).
    fontsdir = os.path.relpath(FONTS, work).replace("\\", "/")
    fc = (
        f"[0:v]scale={W}:{HALF}:force_original_aspect_ratio=increase,crop={W}:{HALF},setsar=1,fps={FPS},split[g][b];"
        f"[b]scale=w='{W}*(1+{ZOOM}*t/{dur:.2f})':h=-2:eval=frame,crop={W}:{HALF},boxblur=10:1,eq=brightness=-0.18[top];"
        f"[top][g]vstack[stk];"
        f"[stk][2:v]overlay=x=0:y='-h+h*min(1,t/{CARD_IN})':enable='lt(t,{card_sec:.2f})'[c];"
        f"[c]ass=caps.ass:fontsdir='{fontsdir}'[cap];"
        f"color=c=0xFFE500:s={W}x{BAR_H}:r={FPS}[bar];"
        f"[cap][bar]overlay=x='-w+w*t/{dur:.2f}':y={HALF - BAR_H // 2}:shortest=1[v]"
    )
    out = outdir / f"{story['id']}.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{start:.2f}", "-stream_loop", "-1", "-i", str(clip),
        "-i", "voice.wav", "-loop", "1", "-i", "card.png",
        "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-t", f"{dur:.2f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out.resolve())],
        check=True, cwd=work)
    print(f"{out.name}: {dur:.1f}s, speed {speed:.2f}, gameplay {clip.name}@{start:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stories", nargs="?", default=HERE / "stories.json", type=Path)
    ap.add_argument("--gameplay", default=ROOT / "gameplay", type=Path)
    ap.add_argument("--out", default=HERE / "out", type=Path)
    ap.add_argument("--only")
    ap.add_argument("--min-sec", type=float, default=62)
    args = ap.parse_args()

    avoid_file = args.gameplay / "avoid.txt"
    avoid = set(avoid_file.read_text(encoding="utf-8").split()) if avoid_file.exists() else set()
    gameplay = sorted(p for p in args.gameplay.iterdir()
                      if p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"} and p.name not in avoid)
    if not gameplay:
        raise SystemExit(f"No gameplay videos in {args.gameplay}")
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    args.out.mkdir(parents=True, exist_ok=True)
    for story in json.loads(args.stories.read_text(encoding="utf-8")):
        if args.only and story["id"] != args.only:
            continue
        render(story, kokoro, gameplay, args.out, args.min_sec)


if __name__ == "__main__":
    main()
