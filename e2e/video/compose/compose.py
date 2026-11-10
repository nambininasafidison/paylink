#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
Composes a demo video (1920x1080, 30 fps, H.264, no audio) from a recording (events.json + screencast frames, written
by video/record*.spec.ts) and the static layers rendered by layers.mjs.

The timeline is the spec's `segments`: full-screen cards (`{"card": id, "dur": s}`) and takes (`{"take": [first cap,
last cap]}`). In a take, each phone shows its latest screencast frame at that moment of the recording; real time plays
1:1 except where the recorder marked a wait (`speed` events), which plays faster. Captions cross-fade in the left
column, the progress bar eases to the step, taps draw a ring where the finger landed. Segments cross-fade.

Usage: compose.py <spec.json> <take dir> <layers dir> <out.mp4> [<contact sheet.png>]
"""
import bisect
import json
import os
import subprocess
import sys
from collections import OrderedDict

import numpy as np
from PIL import Image, ImageDraw

spec_path, take_dir, layer_dir, out_path = sys.argv[1:5]
sheet_path = sys.argv[5] if len(sys.argv) > 5 else None
spec = json.load(open(spec_path))
G = spec["geometry"]
W, H, FPS = 1920, 1080, 30
XF = 0.5  # cross-fade seconds

rec = json.load(open(os.path.join(take_dir, "events.json")))
events = rec["events"]
frames = {s: sorted(rec["frames"][s], key=lambda f: f["t"]) for s in ("L", "R")}
times = {s: [f["t"] for f in frames[s]] for s in ("L", "R")}
caps = [(e["t"], e["id"]) for e in events if e["kind"] == "cap"]
cap_t = {i: t for t, i in caps}
end_t = next((e["t"] for e in events if e["kind"] == "end"), max(times["L"][-1] if times["L"] else 0, times["R"][-1] if times["R"] else 0))
taps = [e for e in events if e["kind"] == "tap"]

# Real time -> output time: piecewise speed.
speeds = sorted((e["t"], float(e["value"])) for e in events if e["kind"] == "speed")
# The spec can scale every marked wait ("waitScale") and play a whole caption faster ("capSpeed": {id: factor}).
wait_scale = float(spec.get("waitScale", 1.0))
cap_speed = spec.get("capSpeed", {})


def factor_at(t):
    f = 1.0
    for k, s in speeds:
        if k <= t:
            f = s
    if f > 1:
        f = 1 + (f - 1) * wait_scale
    c = None
    for k, cid in caps:
        if k <= t:
            c = cid
    return f * float(cap_speed.get(c, 1.0))


points = sorted({caps[0][0] - 5} | {k for k, _ in speeds} | {k for k, _ in caps})
knots = [(k, factor_at(k)) for k in points]


def out_of(t):
    """Output seconds elapsed from knots[0] to real time t."""
    acc, i = 0.0, 0
    for i, (k, s) in enumerate(knots):
        nxt = knots[i + 1][0] if i + 1 < len(knots) else float("inf")
        if t <= nxt:
            return acc + (t - k) / s
        acc += (nxt - k) / s
    return acc


def real_of(o):
    acc = 0.0
    for i, (k, s) in enumerate(knots):
        nxt = knots[i + 1][0] if i + 1 < len(knots) else float("inf")
        span = (nxt - k) / s
        if o <= acc + span:
            return k + (o - acc) * s
        acc += span
    return knots[-1][0]


def load_rgba(name):
    return np.asarray(Image.open(os.path.join(layer_dir, name)).convert("RGBA")).astype(np.float32) / 255.0


bg = np.asarray(Image.open(os.path.join(layer_dir, "bg.png")).convert("RGB")).copy()
idle = Image.open(os.path.join(layer_dir, "idle.png")).convert("RGB")
SW, SH = G["screenW"], G["screenH"]
scr_xy = {"L": (G["phoneLX"] + G["inset"], G["phoneY"] + G["inset"]), "R": (G["phoneRX"] + G["inset"], G["phoneY"] + G["inset"])}

# Rounded mask of a screen (antialiased: drawn 4x, then reduced).
m = Image.new("L", (SW * 4, SH * 4), 0)
ImageDraw.Draw(m).rounded_rectangle((0, 0, SW * 4 - 1, SH * 4 - 1), radius=36 * 4, fill=255)
mask = (np.asarray(m.resize((SW, SH), Image.LANCZOS)).astype(np.float32) / 255.0)[..., None]

cache = OrderedDict()


def screen(side, t):
    i = bisect.bisect_right(times[side], t) - 1
    if i < 0:
        if side == "L" and frames["L"]:
            i = 0
        else:
            key = "idle"
            if key not in cache:
                cache[key] = np.asarray(idle).astype(np.float32)
            return cache[key]
    f = frames[side][i]["f"]
    if f not in cache:
        im = Image.open(os.path.join(take_dir, "frames", f)).convert("RGB").resize((SW, SH), Image.LANCZOS)
        cache[f] = np.asarray(im).astype(np.float32)
        if len(cache) > 300:
            cache.popitem(last=False)
    else:
        cache.move_to_end(f)
    return cache[f]


# Left columns: only the region they use.
COL = (0, 230, 940, 1000)  # x0, y0, x1, y1
cols = {}


def col(cid):
    if cid not in cols:
        a = load_rgba(f"cap_{cid}.png")
        cols[cid] = a[COL[1]:COL[3], COL[0]:COL[2]]
    return cols[cid]


chip = load_rgba("chip.png")


def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blend(dst, src_rgba, x, y, alpha=1.0):
    h, w = src_rgba.shape[:2]
    region = dst[y:y + h, x:x + w].astype(np.float32)
    a = src_rgba[..., 3:4] * alpha
    dst[y:y + h, x:x + w] = (region * (1 - a) + src_rgba[..., :3] * 255.0 * a).astype(np.uint8)


def ring(dst, cx, cy, p):
    """A tap: an orange disc and a white ring that grow and fade (p: 0..1)."""
    r = 13 + 26 * ease(p)
    alpha = (1 - p) ** 1.4
    size = 90
    im = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = size
    d.ellipse((c - r * 2, c - r * 2, c + r * 2, c + r * 2), fill=(255, 90, 31, int(95 * alpha)), outline=(255, 255, 255, int(235 * alpha)), width=5)
    im = im.resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32) / 255.0
    x, y = int(cx - size / 2), int(cy - size / 2)
    if 0 <= x and x + size <= W and 0 <= y and y + size <= H:
        blend(dst, a, x, y)


steps = spec["steps"]
cap_n = {cid: c.get("n", 0) for cid, c in spec["caps"].items()}


def take_frame(t, prev_cap, cur_cap, since):
    """One frame of a take at real time t; `since` is the output seconds since the current caption started."""
    img = bg.copy()
    for side in ("L", "R"):
        x, y = scr_xy[side]
        s = screen(side, t)
        region = img[y:y + SH, x:x + SW].astype(np.float32)
        img[y:y + SH, x:x + SW] = (region * (1 - mask) + s * mask).astype(np.uint8)
    # Taps (output-time animation of 0.7 s).
    o_now = out_of(t)
    for e in taps:
        dt = o_now - out_of(e["t"])
        if 0 <= dt < 0.7:
            x, y = scr_xy[e["side"]]
            ring(img, x + e["x"] * SW / 390, y + e["y"] * SH / 844, dt / 0.7)
    # Caption cross-fade with a short rise.
    k = ease(since / 0.55)
    if prev_cap is not None and k < 1:
        blend(img, col(prev_cap), COL[0], COL[1], 1 - k)
    rise = int(round(14 * (1 - k)))
    c = col(cur_cap)
    if rise:
        blend(img, c[:-rise], COL[0], COL[1] + rise, k)
    else:
        blend(img, c, COL[0], COL[1], k)
    # Progress.
    n_prev = cap_n.get(prev_cap, cap_n[cur_cap] - 1) if prev_cap is not None else cap_n[cur_cap] - 1
    p = (n_prev + (cap_n[cur_cap] - n_prev) * ease(since / 0.9)) / steps
    bx, by, bw = 96, G["barY"], G["barW"]
    img[by - 2:by + 2, bx:bx + max(1, int(bw * p))] = (255, 90, 31)
    return img


def card_frame(cid, p):
    a = cards.setdefault(cid, Image.open(os.path.join(layer_dir, f"card_{cid}.png")).convert("RGB"))
    z = 1.0 + 0.012 * p
    if z > 1.0005:
        w, h = int(W * z), int(H * z)
        im = a.resize((w, h), Image.BICUBIC).crop(((w - W) // 2, (h - H) // 2, (w - W) // 2 + W, (h - H) // 2 + H))
    else:
        im = a
    return np.asarray(im).copy()


cards = {}
enc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                        "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out_path],
                       stdin=subprocess.PIPE)
written = 0
last = None
samples = []  # (label, frame) for the contact sheet


def emit(img, fade_from=None, k=1.0):
    global written, last
    if fade_from is not None and k < 1:
        img = (fade_from.astype(np.float32) * (1 - k) + img.astype(np.float32) * k).astype(np.uint8)
    enc.stdin.write(img.tobytes())
    written += 1
    last = img


for si, seg in enumerate(spec["segments"]):
    start_from = last
    n0 = written
    if "card" in seg:
        n = int(seg["dur"] * FPS)
        for i in range(n):
            img = card_frame(seg["card"], i / n)
            k = ease((i / FPS) / XF) if start_from is not None else ease((i / FPS) / 0.6)
            emit(img, start_from if start_from is not None else np.zeros_like(img), k)
            if i == int(n * 0.6):
                samples.append((seg["card"], last))
        continue
    first, lastcap = seg["take"]
    ids = [i for _, i in caps]
    a, b = ids.index(first), ids.index(lastcap)
    t0 = cap_t[first] - 0.4
    t1 = caps[b + 1][0] if b + 1 < len(caps) else end_t
    o0, o1 = out_of(t0), out_of(t1)
    n = int((o1 - o0) * FPS)
    seg_caps = caps[a:b + 1]
    sample_at = {}
    for j, (ct, cid) in enumerate(seg_caps):
        nxt = seg_caps[j + 1][0] if j + 1 < len(seg_caps) else t1
        sample_at[int((out_of(ct) + 0.72 * (out_of(nxt) - out_of(ct)) - o0) * FPS)] = cid
    for i in range(n):
        o = o0 + i / FPS
        t = real_of(o)
        j = max(0, bisect.bisect_right([c[0] for c in seg_caps], t) - 1)
        cur = seg_caps[j][1]
        prev = seg_caps[j - 1][1] if j > 0 else None
        since = o - out_of(seg_caps[j][0]) if t >= seg_caps[j][0] else 10.0
        img = take_frame(t, prev, cur, since)
        emit(img, start_from, ease((i / FPS) / XF) if start_from is not None else 1.0)
        if i in sample_at:
            samples.append((sample_at[i], last))

# Fade the end to black.
for i in range(int(0.8 * FPS)):
    emit((last.astype(np.float32) * (1 - ease(i / (0.8 * FPS)))).astype(np.uint8))
enc.stdin.close()
enc.wait()
print(f"{out_path}: {written / FPS:.1f} s, {written} frames")

if sheet_path:
    tw, th, cols_n = 640, 360, 4
    rows = (len(samples) + cols_n - 1) // cols_n
    sheet = Image.new("RGB", (cols_n * tw, rows * th), (0, 0, 0))
    for i, (label, img) in enumerate(samples):
        sheet.paste(Image.fromarray(img).resize((tw, th), Image.LANCZOS), ((i % cols_n) * tw, (i // cols_n) * th))
    sheet.save(sheet_path)
    for i, (label, img) in enumerate(samples):
        Image.fromarray(img).save(os.path.join(os.path.dirname(sheet_path), f"_frame_{i:02d}_{label}.png"))
    print(f"{sheet_path}: {len(samples)} frames")
