"""Review one reel: download -> media analysis -> transcript -> vision -> rule checks.

Every stage is cached as JSON under data/cache/<file_id>/, so a crash, restart or Groq outage
resumes where it stopped instead of starting over. Stages that need Groq degrade (they are
listed in report["skipped"]) instead of failing the review.
"""
import re
import json
import wave
import time
import base64
import difflib
import hashlib
import urllib.request
from pathlib import Path

import av
import numpy as np
import yt_dlp

import gemini
import llm

DATA = Path(__file__).parent / "data"
CACHE = DATA / "cache"
STATS_FPS, FRAME_FPS = 5, 2      # colour/cut stats sampling, saved JPEG keyframes
MAX_VISION_FRAMES = 48           # 6 vision calls per reel
SHEET_TILES, SHEET_COLS, TILE_W = 8, 4, 360
# Groq's limiter charges ~2K input tokens PER IMAGE regardless of size (ITPM cap 7000 on the free tier),
# so frames go as one labelled 4x2 contact sheet per call. Tested: 8/8 captions read exactly as single frames.
# The binding limit is qwen's 200K tokens/day: ~2.2K per sheet -> ~13K per reel -> ~14 reels/day.
# That is why Gemini (whole video, one request) is tried first; this Groq path is the fallback.
MAX_BYTES = 500_000_000   # refuse to download anything bigger (reels are ~70 MB)
MAX_DURATION_S = 600      # ...or longer than 10 minutes (reels are ~2 min): protects quota and disk
# Gemini severity per rule; vision moments (mood/chart) are checked separately in run_checks
GEMINI_RULES = {"too_many_broll": ("pacing", "medium"), "jarring_visuals": ("visual", "medium"),
                "no_negative_graphs": ("visual", "high"), "visuals_match_speech": ("relevance", "medium"),
                "audio_mix": ("audio", "low")}


# ---------- helpers ----------
def file_id(url: str) -> str:
    m = re.search(r"/d/([\w-]{20,})|[?&]id=([\w-]{20,})", url)
    if m:
        return m.group(1) or m.group(2)
    if re.fullmatch(r"[\w-]{20,}", url.strip()):
        return url.strip()
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def mss(t: float) -> str:
    """Nidhi writes timestamps as m.ss (e.g. 0.16 = 16 seconds)."""
    t = max(0, int(round(t)))
    return f"{t // 60}.{t % 60:02d}"


def _stage(d: Path, name: str, fn):
    p = d / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    out = fn()
    p.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    return out


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


# ---------- 1. download ----------
def download(url: str, d: Path) -> Path:
    done = [p for p in d.glob("video.*") if p.suffix not in (".part", ".ytdl")]
    if done:
        return done[0]
    try:
        opts = {"outtmpl": str(d / "video.%(ext)s"), "quiet": True, "noprogress": True, "format": "best",
                "noplaylist": True, "max_filesize": MAX_BYTES, "socket_timeout": 30, "retries": 3}
        with yt_dlp.YoutubeDL(opts) as y:
            return Path(y.prepare_filename(y.extract_info(url, download=True)))
    except Exception:
        if "drive.google" not in url:
            raise
    # Fallback: Drive direct download endpoint (works for public files, skips the virus-scan page)
    out = d / "video.mp4"
    req = urllib.request.Request(
        f"https://drive.usercontent.google.com/download?id={file_id(url)}&export=download&confirm=t",
        headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(out, "wb") as f:
        if "text/html" in r.headers.get("Content-Type", ""):
            raise RuntimeError("Drive returned a web page instead of the video - is the file shared publicly?")
        size = 0
        while chunk := r.read(1 << 20):
            size += len(chunk)
            if size > MAX_BYTES:
                f.close()
                out.unlink(missing_ok=True)
                raise RuntimeError(f"Video is larger than {MAX_BYTES // 1_000_000} MB - refusing to download it")
            f.write(chunk)
    return out


# ---------- 2. media analysis (local, no API) ----------
def analyze_media(video: Path, d: Path) -> dict:
    fdir = d / "frames"
    fdir.mkdir(exist_ok=True)
    c = av.open(str(video))
    if c.duration and c.duration / 1e6 > MAX_DURATION_S:
        c.close()
        raise ValueError(f"Video is longer than {MAX_DURATION_S // 60} minutes - this tool reviews short reels")
    vs = c.streams.video[0]
    vs.thread_type = "AUTO"
    W, H = vs.codec_context.width, vs.codec_context.height
    fw = 540 if W <= H else 960
    fh = int(round(fw * H / W / 2) * 2)
    samples, frames = [], []
    next_s = next_f = 0.0
    for fr in c.decode(vs):
        t = float(fr.time or 0)
        if t >= next_s:
            samples.append((t, fr.to_ndarray(width=72, height=int(72 * H / W), format="rgb24").astype(np.float32)))
            next_s += 1 / STATS_FPS
        if t >= next_f:
            name = f"{t:08.3f}.jpg"
            fr.to_image(width=fw, height=fh).save(fdir / name, "JPEG", quality=82)
            frames.append({"t": round(t, 3), "file": name})
            next_f += 1 / FRAME_FPS
    duration = float(c.duration / 1e6) if c.duration else (samples[-1][0] if samples else 0)
    fps = float(vs.average_rate or 0)
    c.close()

    # cuts: big jumps in a tiny greyscale thumbnail between consecutive samples
    grey = [a.mean(axis=2) for _, a in samples]
    diffs = np.array([0.0] + [float(np.abs(grey[i] - grey[i - 1]).mean()) for i in range(1, len(grey))])
    thr = max(18.0, 4 * float(np.median(diffs[1:])) if len(diffs) > 1 else 18.0)  # ponytail: tuned on 1 reel
    cuts = []
    for i in np.where(diffs > thr)[0]:
        t = samples[i][0]
        if not cuts or t - cuts[-1] > 0.6:
            cuts.append(round(t, 2))

    bounds = [0.0] + cuts + [duration]
    shots = []
    for a, b in zip(bounds, bounds[1:]):
        arrs = [x for t, x in samples if a <= t < b] or [samples[-1][1]]
        m = np.stack(arrs).reshape(-1, 3)
        mx, mn = m.max(axis=1), m.min(axis=1)
        shots.append({
            "start": round(a, 2), "end": round(b, 2),
            "luma": round(float((m @ np.array([0.299, 0.587, 0.114])).mean()), 1),
            "sat": round(float(((mx - mn) / np.maximum(mx, 1)).mean()), 3),
            "warmth": round(float(m[:, 0].mean() - m[:, 2].mean()), 1),
        })
    return {"duration": round(duration, 2), "width": W, "height": H, "fps": round(fps, 2),
            "cuts": cuts, "shots": shots, "frames": frames, **analyze_audio(video, d, shots)}


def analyze_audio(video: Path, d: Path, shots: list) -> dict:
    c = av.open(str(video))
    if not c.streams.audio:
        c.close()
        return {"has_audio": False}
    res = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = [r.to_ndarray().reshape(-1) for fr in c.decode(audio=0) for r in res.resample(fr)]
    chunks += [r.to_ndarray().reshape(-1) for r in res.resample(None)]
    c.close()
    pcm = np.concatenate(chunks).astype(np.int16) if chunks else np.zeros(1, np.int16)
    with wave.open(str(d / "audio.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm.tobytes())

    x = pcm.astype(np.float32) / 32768
    win = 8000  # 0.5 s
    n = len(x) // win
    db = lambda v: float(20 * np.log10(max(v, 1e-6)))
    windows = [round(db(np.sqrt(np.mean(x[i * win:(i + 1) * win] ** 2))), 1) for i in range(n)]
    for s in shots:
        seg = x[int(s["start"] * 16000):int(s["end"] * 16000)]
        s["audio_db"] = round(db(np.sqrt(np.mean(seg ** 2))) if len(seg) else -120, 1)
    return {"has_audio": True, "rms_db": round(db(np.sqrt(np.mean(x ** 2))), 1),
            "peak_db": round(db(np.abs(x).max()), 1),
            "clip_pct": round(float((np.abs(pcm) >= 32700).mean() * 100), 3), "windows_db": windows}


# ---------- 3. vision (Groq, one 6-frame contact sheet per call) ----------
VISION_PROMPT = """This image is a contact sheet of {n} numbered frames from a vertical educational reel (IIM Bangalore faculty development programme).
Each tile has a yellow label "#k time" in its top-left corner; read left-to-right, top-to-bottom. Times: {times}.
Ignore the yellow labels themselves. For EACH frame return an object:
{{"n": tile number,
  "caption": exact burned-in subtitle text, or null if there is no subtitle,
  "onscreen_text": other visible text such as titles/labels, or null,
  "shot": one of "professor", "ai_image", "broll", "graphic", "title_card", "other",
  "description": what is shown, max 12 words,
  "issues": list of short, concrete, clearly visible problems (e.g. "blurry", "AI artifacts: distorted hands", "text cut off at edge", "caption overlaps face", "spelling mistake in on-screen text: <word>") - [] if none; do not guess,
  "motion": visible transition/animation into this tile, or null,
  "mood": "calm", "neutral" or "alarming" - alarming = sudden aggressive/scary/distressing imagery (bared teeth, red warning colours, violence, crying, crashes),
  "chart": "down" if the tile shows a graph, arrow or trend going down / declining / negative, "up" if rising, else "none"}}
Return a JSON list with exactly {n} objects, nothing else."""


def pick_frames(media: dict) -> list[dict]:
    frames = media["frames"]
    if not frames:
        return []
    times = np.array([f["t"] for f in frames])
    dur = media["duration"]
    step = max(1.5, dur / (MAX_VISION_FRAMES * 0.7))
    want = [0.0] + list(np.arange(step, dur, step))
    want += [c + 0.3 for c in media["cuts"]]  # just after each cut: new shot + how it transitioned in
    idx = sorted({int(np.abs(times - t).argmin()) for t in want if 0 <= t <= dur})
    if len(idx) > MAX_VISION_FRAMES:  # thin evenly, always keep the first frame
        idx = [idx[0]] + [idx[int(i)] for i in np.linspace(1, len(idx) - 1, MAX_VISION_FRAMES - 1)]
    return [frames[i] for i in idx]


def _contact_sheet(d: Path, batch: list[dict]) -> str:
    from PIL import Image, ImageDraw, ImageFont
    import io
    ims = [Image.open(d / "frames" / f["file"]) for f in batch]
    tw, th = TILE_W, int(ims[0].height * TILE_W / ims[0].width)
    rows = (len(ims) + SHEET_COLS - 1) // SHEET_COLS
    sheet = Image.new("RGB", (min(len(ims), SHEET_COLS) * tw, rows * th), "black")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=26)
    for i, (f, im) in enumerate(zip(batch, ims)):
        x, y = (i % SHEET_COLS) * tw, (i // SHEET_COLS) * th
        sheet.paste(im.resize((tw, th)), (x, y))
        draw.rectangle([x, y, x + 150, y + 36], fill="black")
        draw.text((x + 6, y + 4), f"#{i + 1} {f['t']:.1f}s", fill="yellow", font=font)
    buf = io.BytesIO()
    sheet.save(buf, "JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def gemini_stage(media: dict, d: Path, video: Path | None, progress=None) -> dict:
    """Whole-video review by Gemini, cached. {} when Gemini isn't configured/available (Groq then does the vision)."""
    p = d / "gemini.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    if video is None or not gemini.available():
        return {}
    if progress:
        progress("vision", 0)
    try:
        g = gemini.analyze(video, media["duration"])
    except gemini.Unavailable as e:
        gemini.log(f"unavailable ({e}) - using Groq vision for this reel")
        return {}
    p.write_text(json.dumps(g, indent=1, ensure_ascii=False), encoding="utf-8")
    return g


def run_vision(media: dict, d: Path, progress=None, gem: dict | None = None) -> list[dict]:
    p = d / "vision.json"
    done = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    out = {v["t"]: v for v in done if not v.get("skipped")}  # old skips are retried below
    moments = (gem or {}).get("moments", [])
    for f in pick_frames(media):  # Gemini's timeline -> the same per-frame records Groq produces
        m = min(moments, key=lambda m: abs(m["t"] - f["t"]), default=None)
        if m and abs(m["t"] - f["t"]) <= 1.0:
            out[f["t"]] = {**m, "t": f["t"], "file": f["file"]}
    todo = [f for f in pick_frames(media) if not any(abs(f["t"] - t) < 0.8 for t in out)]
    batches = [todo[i:i + SHEET_TILES] for i in range(0, len(todo), SHEET_TILES)]
    for bi, batch in enumerate(batches):
        if progress:
            progress("vision", bi / max(len(batches), 1))
        prompt = VISION_PROMPT.format(n=len(batch), times=", ".join(f"#{i + 1}={f['t']:.1f}s" for i, f in enumerate(batch)))
        try:
            res = llm.vision_json(prompt, [_contact_sheet(d, batch)], max_tokens=1600)
            res = res if isinstance(res, list) else res.get("frames", [res])
        except llm.LLMUnavailable:
            res = []
        res = [r for r in res if isinstance(r, dict)]
        by_n = {r.get("n"): r for r in res if isinstance(r.get("n"), int)}
        for i, f in enumerate(batch):
            v = by_n.get(i + 1) or (res[i] if len(by_n) < len(res) and i < len(res) else None) or {"skipped": True}
            out[f["t"]] = {**v, "t": f["t"], "file": f["file"]}
        p.write_text(json.dumps(sorted(out.values(), key=lambda v: v["t"]), indent=1, ensure_ascii=False), encoding="utf-8")
    return sorted(out.values(), key=lambda v: v["t"])


# ---------- 4. rule checks (local, no API) ----------
def _finding(t, end, category, severity, rule, note, evidence="", basis="observed"):
    return {"t": round(t, 2), "end": round(end, 2), "category": category, "severity": severity,
            "rule": rule, "basis": basis, "note": note, "evidence": evidence}


def _ranges(ts: list[float], gap: float = 2.6):
    out = []
    for t in sorted(ts):
        if out and t - out[-1][1] <= gap:
            out[-1][1] = t
        else:
            out.append([t, t])
    return out


def run_checks(media: dict, transcript: dict | None, vision: list[dict], gem: dict | None = None) -> list[dict]:
    F = []
    words = (transcript or {}).get("words", [])
    seen = [v for v in vision if not v.get("skipped")]
    # Whisper stretches words over following silence (04_04: last word 101.1->105.3s), so cap each word at 1s
    speaking = lambda t: any(w["start"] - 0.25 <= t <= min(w["end"], w["start"] + 1.0) + 0.25 for w in words)

    # captions: speech with no caption on screen  (Nidhi 04_04 "Captions missing in 0.16second")
    if words and seen:
        missing = [v for v in seen if speaking(v["t"]) and not (v.get("caption") or "").strip()]
        for a, b in _ranges([v["t"] for v in missing]):
            when = f"at {mss(a)}" if b - a < 1.5 else f"from {mss(a)} to {mss(b)}"
            said = {x for w in words if a - 1 <= w["start"] <= b + 1 for x in _words(w["word"]) if len(x) > 3}
            card = all(set(_words(v.get("onscreen_text") or "")) & said for v in missing if a <= v["t"] <= b)
            if card:  # a title card that spells out the spoken words - softer gap
                F.append(_finding(a, b, "captions", "low", "captions_missing",
                                  f"No captions {when} while the title card is up - keep the subtitles running under it",
                                  "speech over a title card that repeats the words, no subtitle", "predicted"))
            else:
                F.append(_finding(a, b, "captions", "high", "captions_missing", f"Captions missing {when}",
                                  "speech detected but no subtitle visible"))

        # captions: spelling / wording that doesn't match what was said
        spoken = "".join(x for w in words for x in _words(w["word"]))  # catches "notebooklm" heard as "notebook LM"
        checked = set()
        for v in seen:
            cap = (v.get("caption") or "").strip()
            if not cap or cap.lower() in checked:
                continue
            checked.add(cap.lower())
            said = {x for w in words if v["t"] - 4 <= w["start"] <= v["t"] + 2 for x in _words(w["word"])}
            if not said:
                continue
            for cw in set(_words(cap)) - said:
                if cw in spoken:  # a real word from this reel, just timed differently - not a typo
                    continue
                close = difflib.get_close_matches(cw, list(said), n=1, cutoff=0.75)
                if close and len(cw) > 3:
                    F.append(_finding(v["t"], v["t"], "captions", "medium", "caption_typo",
                                      f'Caption typo at {mss(v["t"])} - "{cw}" should be "{close[0]}"',
                                      f'caption: "{cap}"', "predicted"))

    # opening shot  (Nidhi 04_13 "lets start with prof face and then bring the ai component")
    if seen and seen[0].get("shot") not in (None, "professor"):
        F.append(_finding(0, seen[0]["t"], "structure", "medium", "open_with_professor",
                          f"Starting with {seen[0]['shot'].replace('_', ' ')} doesn't look good, lets start with prof face and then bring the {seen[0]['shot'].replace('_', ' ')}",
                          seen[0].get("description", "")))

    # grading: a cutaway whose colour stands out  (Nidhi 04_06 "grading vs delivery not good on the scooter")
    # The house style grades AI/b-roll brighter and cooler than the professor (fixed 04_04: luma +33..+85,
    # warmth -23..-67 and approved), so compare each cutaway with the reel's OTHER cutaways when there are enough.
    def shot_type(s):
        types = [v.get("shot") for v in seen if s["start"] <= v["t"] < s["end"]]
        return max(set(types), key=types.count) if types else None
    for s in media["shots"]:
        s["type"] = shot_type(s)
    cuts_ = [s for s in media["shots"] if s["type"] in ("broll", "ai_image") and s["end"] - s["start"] >= 0.8]
    prof = [s for s in media["shots"] if s["type"] == "professor" and s["end"] - s["start"] >= 1]
    pool, lim, vs = (cuts_, (45, 30, 0.2), "the other cutaways") if len(cuts_) >= 3 else \
        (prof, (95, 75, 0.5), "the prof footage")  # ponytail: limits sit just past what she approved
    if pool:
        ref = {k: float(np.median([s[k] for s in pool])) for k in ("luma", "warmth", "sat")}
        for s in cuts_:
            dl, dw, ds = s["luma"] - ref["luma"], s["warmth"] - ref["warmth"], s["sat"] - ref["sat"]
            if abs(dl) > lim[0] or abs(dw) > lim[1] or abs(ds) > lim[2]:
                what = "too bright" if dl > lim[0] else "too dark" if dl < -lim[0] else "too warm" if dw > lim[1] else \
                    "too cool" if dw < -lim[1] else "too saturated" if ds > 0 else "washed out"
                F.append(_finding(s["start"], s["end"], "grading", "medium", "grade_matches_delivery",
                                  f"Grading vs delivery not good at {mss(s['start'])}, the {s['type'].replace('_', ' ')} looks {what} next to {vs}",
                                  f"luma {dl:+.0f}, warmth {dw:+.0f}, sat {ds:+.2f} vs {vs}"))

    # too much happening  (Nidhi: "too many b rolls it becomes overwhelming")
    per_min = len(media["cuts"]) / max(media["duration"], 1) * 60
    typed = [s for s in media["shots"] if s["type"]]
    typed_t = sum(s["end"] - s["start"] for s in typed)
    prof_share = sum(s["end"] - s["start"] for s in typed if s["type"] == "professor") / typed_t if typed_t else None
    if per_min > 20 or (prof_share is not None and typed_t > 0.7 * media["duration"] and prof_share < 0.45):
        F.append(_finding(0, media["duration"], "pacing", "medium", "too_many_broll",
                          "Too many b-rolls / too much happening, it becomes overwhelming - bring the prof back on screen and keep only the cutaways that matter",
                          f"{per_min:.0f} cuts/min" + (f", professor on screen {prof_share:.0%} of the time" if prof_share is not None else "")
                          + " (fixed 04_04: 14 cuts/min, 56% professor)"))  # ponytail: limits are guesses

    # jarring imagery and downward graphs  (Nidhi: red barking teeth; "graphs going down ... at any cost")
    for rule, key, val, sev, note in [
            ("jarring_visuals", "mood", "alarming", "medium", "That visual feels sudden and negative at {t}, swap it for something calmer"),
            ("no_negative_graphs", "chart", "down", "high", "Graph / arrow going down at {t}, no negative graphs in the animations please, replace it")]:
        for a, b in _ranges([v["t"] for v in seen if v.get("shot") != "professor" and v.get(key) == val]):
            F.append(_finding(a, b, "visual", sev, rule, note.format(t=mss(a)), "vision model: " + key + "=" + val))

    # audio
    if not media.get("has_audio"):
        F.append(_finding(0, media["duration"], "audio", "high", "audio_present", "No audio track in the export", basis="technical"))
    else:
        if media["rms_db"] < -30 and media["peak_db"] < -10:  # ponytail: approved 04_04 sits at -37.7 rms / -16.6 peak
            F.append(_finding(0, media["duration"], "audio", "low", "audio_level", "Audio feels low overall, can we bring the levels up a bit",
                              f"RMS {media['rms_db']} dBFS, peak {media['peak_db']} dBFS", "predicted"))
        if media["clip_pct"] > 0.1:
            F.append(_finding(0, media["duration"], "audio", "medium", "audio_clipping", "Audio is distorting / clipping in places",
                              f"{media['clip_pct']}% samples clipped", "technical"))
        if words:
            first, last = words[0]["start"], words[-1]["end"]
            quiet = [i * 0.5 for i, v in enumerate(media["windows_db"]) if v < -45 and first < i * 0.5 < last]
            for a, b in _ranges(quiet, gap=0.5):
                if b - a >= 1.5:
                    F.append(_finding(a, b + 0.5, "audio", "low", "dead_air", f"Dead air from {mss(a)} to {mss(b + 0.5)}, tighten the cut",
                                      basis="predicted"))
        sh = media["shots"]
        for p, q in zip(sh, sh[1:]):
            if p.get("audio_db", -120) > -40 and q.get("audio_db", -120) > -40 and abs(p["audio_db"] - q["audio_db"]) > 8:
                F.append(_finding(q["start"], q["start"], "audio", "medium", "audio_jump",
                                  f"Audio level jumps at {mss(q['start'])}", f"{p['audio_db']} -> {q['audio_db']} dB", "predicted"))

    # format
    if media["width"] * 16 != media["height"] * 9:
        F.append(_finding(0, 0, "format", "high", "vertical_9x16", f"Export is {media['width']}x{media['height']}, reels need to be 9:16",
                          basis="technical"))
    elif media["height"] < 1920:
        F.append(_finding(0, 0, "format", "low", "full_hd", f"Export is {media['width']}x{media['height']}, please export at 1080x1920",
                          basis="technical"))

    # visible issues the vision model reported (merged when the same issue repeats on consecutive frames)
    by_issue: dict[str, list[float]] = {}
    for v in seen:
        for iss in v.get("issues") or []:
            by_issue.setdefault(str(iss).strip().lower(), []).append(v["t"])
    for iss, ts in by_issue.items():
        for a, b in _ranges(ts):
            F.append(_finding(a, b, "visual", "low", "vision_issue", f"{iss[:1].upper()}{iss[1:]} at {mss(a)}", basis="predicted"))
    # whole-video findings from Gemini; skip ones a local/per-frame check already raised for the same moment
    for g in (gem or {}).get("findings", []):
        if any(f["rule"] == g["rule"] and f["t"] <= g["end"] + 2 and g["t"] <= f["end"] + 2 for f in F):
            continue
        cat, sev = GEMINI_RULES[g["rule"]]
        F.append(_finding(g["t"], g["end"], cat, sev, g["rule"], g["note"], "gemini: " + g["evidence"]))
    return sorted(F, key=lambda f: f["t"])


# ---------- orchestration ----------
def review(url: str, progress=None) -> dict:
    """Run all local + Groq stages for one reel. Returns the facts the note-writer needs."""
    fid = file_id(url)
    d = CACHE / fid
    d.mkdir(parents=True, exist_ok=True)
    say = progress or (lambda *a: None)
    skipped = []

    say("downloading", 0)
    video = download(url, d)
    say("analysing", 0)
    media = _stage(d, "media", lambda: analyze_media(video, d))

    say("transcribing", 0)
    transcript = None
    if media.get("has_audio"):
        try:
            transcript = _stage(d, "transcript", lambda: llm.transcribe(str(d / "audio.wav")))
        except Exception as e:  # even local whisper failed
            skipped.append(f"transcript ({e})")

    gem = gemini_stage(media, d, video, say)
    vision = run_vision(media, d, say, gem)
    retry_at = 0.0
    if not any(not v.get("skipped") for v in vision):
        skipped.append("vision (Groq vision unavailable - caption, opening-shot and grading checks limited)")
    elif any(v.get("skipped") for v in vision):
        skipped.append(f"vision on {sum(1 for v in vision if v.get('skipped'))} frames")
    if any(v.get("skipped") for v in vision):  # caller re-runs the review then; finished frames stay cached
        retry_at = llm.available_at(llm.VISION_MODELS) or time.time() + 600

    say("checking", 0)
    findings = run_checks(media, transcript, vision, gem)
    return {"file_id": fid, "url": url, "media": media, "transcript": transcript, "vision": vision, "findings": findings,
            "skipped": skipped, "retry_at": retry_at, "vision_source": gem.get("model") or "groq"}


if __name__ == "__main__":
    import sys
    assert mss(16) == "0.16" and mss(77.6) == "1.18"
    assert file_id("https://drive.google.com/file/d/1VcjsRffEqQewqQmr9GfAVEpcp2b-i7dV/view?usp=x") == "1VcjsRffEqQewqQmr9GfAVEpcp2b-i7dV"
    assert _ranges([1, 2, 3, 9]) == [[1, 3], [9, 9]]
    if len(sys.argv) > 1:
        r = review(sys.argv[1], lambda s, p: print(f"  {s} {p:.0%}", flush=True))
        print(json.dumps(r["findings"], indent=1), "\nskipped:", r["skipped"])
