"""Everything Nidhi-specific: the review sheet, her rulebook (observed + predicted), notes in her voice, backtest."""
import re
import csv
import io
import json
import time
import urllib.request
from pathlib import Path

import llm
import review

SHEET_CSV = "https://docs.google.com/spreadsheets/d/115EloGl-euhjooZLgi7rarHPh57oGeHf_2eSyX1fCtk/export?format=csv&gid=0"
FOLDER_URL = "https://drive.google.com/drive/folders/1cy0v_6yXtuwbMuldn0nvRUGyQIJg0jSD"
DATA = review.DATA
RULEBOOK = DATA / "rulebook.json"

# Rules read straight from her comments in the sheet. Predicted rules are generated from these.
SEED_RULES = [
    {"id": "captions_missing", "category": "captions",
     "rule": "Every spoken line must have a caption on screen - no gaps, especially at the start.",
     "examples": [{"reel": "04_04", "editor": "Ashick", "note": "Captions missing in 0.16second"}]},
    {"id": "grade_matches_delivery", "category": "grading",
     "rule": "B-roll / cutaway shots must be colour graded to match the professor's delivery footage.",
     "examples": [{"reel": "04_06", "editor": "Ashick", "note": "Grading vs delivery not good on the scooter at 0.07"}]},
    {"id": "open_with_professor", "category": "structure",
     "rule": "Open on the professor's face; bring AI imagery in only after the professor is established.",
     "examples": [{"reel": "04_13", "editor": "Ashick", "note": "Starting with ai image does look good lets start with prof face and then bring the ai componenet"}]},
    {"id": "visuals_match_speech", "category": "relevance",
     "rule": "Visuals on screen must illustrate exactly what the speaker is saying at that moment.",
     "examples": [{"reel": "05_01", "editor": "Karthik", "note": "0,37 sec to 0.46 sec visuals not matching what the speaker says"}]},
    # told to us directly (chat), not from the sheet
    {"id": "too_many_broll", "category": "pacing",
     "rule": "Too many b-rolls / too much happening at once is overwhelming - keep the professor on screen and use cutaways sparingly.",
     "examples": [{"reel": "-", "editor": "-", "note": "too many b rolls it becomes overwhelming"}]},
    {"id": "jarring_visuals", "category": "relevance",
     "rule": "No sudden, alarming or negative imagery in cutaways (e.g. a barking dog with red bared teeth popping up on the word 'bark').",
     "examples": [{"reel": "-", "editor": "-", "note": "a dog bark was the word and a red sudden barking teeth came up which feels weird and also negative"}]},
    {"id": "no_negative_graphs", "category": "relevance",
     "rule": "Never use graphs or arrows going down / declining charts in the b-roll animations - at any cost.",
     "examples": [{"reel": "-", "editor": "-", "note": "graphs going down shouldn't be taken in the b roll animations at any cost"}]},
]


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def _cached(name: str, fn):
    """Fetch fresh; if the network/Google is down, fall back to the last good copy."""
    p = DATA / name
    try:
        out = fn()
        DATA.mkdir(exist_ok=True)
        p.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
        return out
    except Exception:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
        raise


def parse_times(note: str) -> list[float]:
    """Her timestamps are m.ss ('0.16', '0,37 sec') -> seconds."""
    return [int(m) * 60 + int(s) for m, s in re.findall(r"(?<![\d.])(\d{1,2})[.,:](\d{2})(?!\d)", note or "")]


def drive_files() -> dict:
    """Reel name -> newest Drive file in the review folder (folder page is public HTML)."""
    def fetch():
        html = _get(FOLDER_URL)
        out = {}
        for fid, tip in re.findall(r'data-id="([\w-]{20,})"[^>]*data-tooltip="([^"]+)"', html):
            name = re.sub(r"\s+", "", tip.rsplit(" ", 1)[0]).removesuffix(".mp4").strip("_")
            if not re.match(r"\d", name):
                continue
            m = re.search(r"_v(\d+)$", name)
            base, ver = (name[:m.start()], int(m.group(1))) if m else (name, 1)
            if base not in out or ver > out[base]["version"]:
                out[base] = {"id": fid, "name": tip.rsplit(" ", 1)[0], "version": ver}
        return out
    return _cached("drive_files.json", fetch)


def find_v2_candidates(reel_name: str) -> list[dict]:
    """Finds all Drive files matching reel_name and their version tags."""
    def fetch_all():
        html = _get(FOLDER_URL)
        out = []
        for fid, tip in re.findall(r'data-id="([\w-]{20,})"[^>]*data-tooltip="([^"]+)"', html):
            fname = tip.rsplit(" ", 1)[0]
            clean = re.sub(r"\s+", "", fname).removesuffix(".mp4").strip("_")
            m = re.search(r"_v(\d+)$", clean)
            base = clean[:m.start()] if m else clean
            ver = int(m.group(1)) if m else 1
            out.append({
                "base": base,
                "version": ver,
                "name": fname,
                "id": fid,
                "url": f"https://drive.google.com/file/d/{fid}/view"
            })
        return out
    all_files = _cached("drive_files_all.json", fetch_all)
    matches = [f for f in all_files if f["base"] == reel_name or reel_name in f["name"]]
    matches.sort(key=lambda x: x["version"], reverse=True)
    return matches


def reels() -> list[dict]:
    """Sheet rows merged with Drive files, prioritizing user-confirmed v2 videos."""
    def fetch():
        rows = list(csv.reader(io.StringIO(_get(SHEET_CSV))))
        start = next(i for i, r in enumerate(rows) if r and r[0].strip().lower() == "reels") + 1
        return [r for r in rows[start:] if r and r[0].strip()]
    rows = _cached("sheet.json", fetch)
    files = drive_files()

    rev_p = DATA / "revisions.json"
    rev_data = json.loads(rev_p.read_text(encoding="utf-8")) if rev_p.exists() else {}

    out = []
    for r in rows:
        r = (r + [""] * 6)[:6]
        name = r[0].strip()
        f = files.get(name)
        link = r[5].strip() or (f"https://drive.google.com/file/d/{f['id']}/view" if f else "")
        fid = review.file_id(link) if link else None
        dname = f["name"] if f else None
        ver = f["version"] if f else None

        # If a locked v2 video was confirmed by user, prioritize it permanently
        locked_v2 = rev_data.get(name, {}).get("v2_video")
        if locked_v2 and locked_v2.get("confirmed"):
            link = locked_v2.get("url") or link
            fid = locked_v2.get("file_id") or fid
            dname = locked_v2.get("name") or dname
            ver = 2

        out.append({"reel": name, "status": r[2].strip(), "editor": r[3].strip(), "notes": r[4].strip(),
                    "link": link, "file_id": fid,
                    "drive_name": dname, "version": ver,
                    "v2_confirmed": bool(locked_v2 and locked_v2.get("confirmed"))})
    return out


def sync_sheet_and_drive() -> list[dict]:
    """Force fresh fetch from Google Sheets CSV and Google Drive folder."""
    rows_raw = list(csv.reader(io.StringIO(_get(SHEET_CSV))))
    start = next(i for i, r in enumerate(rows_raw) if r and r[0].strip().lower() == "reels") + 1
    sheet_rows = [r for r in rows_raw[start:] if r and r[0].strip()]
    (DATA / "sheet.json").write_text(json.dumps(sheet_rows, indent=1, ensure_ascii=False), encoding="utf-8")

    html = _get(FOLDER_URL)
    files = {}
    for fid, tip in re.findall(r'data-id="([\w-]{20,})"[^>]*data-tooltip="([^"]+)"', html):
        name = re.sub(r"\s+", "", tip.rsplit(" ", 1)[0]).removesuffix(".mp4").strip("_")
        if not re.match(r"\d", name):
            continue
        m = re.search(r"_v(\d+)$", name)
        base, ver = (name[:m.start()], int(m.group(1))) if m else (name, 1)
        if base not in files or ver > files[base]["version"]:
            files[base] = {"id": fid, "name": tip.rsplit(" ", 1)[0], "version": ver}
    (DATA / "drive_files.json").write_text(json.dumps(files, indent=1, ensure_ascii=False), encoding="utf-8")

    return reels()


# ---------- rulebook ----------
def load_rulebook() -> dict:
    rb = json.loads(RULEBOOK.read_text(encoding="utf-8")) if RULEBOOK.exists() else {"rules": [], "updated": None}
    have = {r["id"] for r in rb["rules"]}
    rb["rules"] = [{**r, "basis": "observed", "status": "active", "confidence": 1.0} for r in SEED_RULES if r["id"] not in have] + rb["rules"]
    return rb


def save_rulebook(rb: dict):
    DATA.mkdir(exist_ok=True)
    rb["updated"] = time.strftime("%Y-%m-%d %H:%M")
    RULEBOOK.write_text(json.dumps(rb, indent=1, ensure_ascii=False), encoding="utf-8")


def _rules_text(rb: dict, basis: str) -> str:
    lines = []
    for r in rb["rules"]:
        if r["basis"] == basis and r["status"] != "rejected":
            ex = "; ".join(f'"{e["note"]}"' for e in r.get("examples", [])[:2])
            lines.append(f'- [{r["id"]}] ({r["category"]}) {r["rule"]}' + (f"  Her words: {ex}" if ex else ""))
    return "\n".join(lines) or "(none)"


def learn(predict: bool = True) -> dict:
    """Sync new sheet comments into observed rules, then (re)generate predicted rules."""
    rb = load_rulebook()
    known = {e["note"] for r in rb["rules"] for e in r.get("examples", [])}
    new = [x for x in reels() if x["notes"] and x["notes"] not in known]
    for x in new:
        ids = [r["id"] for r in rb["rules"] if r["basis"] == "observed"]
        try:
            res = llm.chat_json(
                "You classify a video review comment into a rulebook. Return JSON only.",
                f"Existing rules:\n{_rules_text(rb, 'observed')}\n\nNew comment from the manager on reel {x['reel']}: \"{x['notes']}\"\n"
                'If it is an instance of an existing rule return {"id": "<existing id>"}. Otherwise return '
                '{"id": "<new_snake_case_id>", "category": "captions|grading|structure|relevance|audio|animation|text|branding|pacing|other", '
                '"rule": "<the general rule she is enforcing, one sentence>"}')
        except llm.LLMUnavailable:
            res = {"id": f"note_{x['reel']}", "category": "other", "rule": x["notes"]}
        ex = {"reel": x["reel"], "editor": x["editor"], "note": x["notes"]}
        rule = next((r for r in rb["rules"] if r["id"] == res.get("id")), None)
        if rule:
            rule.setdefault("examples", []).append(ex)
        elif res.get("id") not in ids:
            rb["rules"].append({"id": res["id"], "category": res.get("category", "other"), "rule": res.get("rule", x["notes"]),
                                "examples": [ex], "basis": "observed", "status": "active", "confidence": 1.0})
    if predict:
        rb = predict_rules(rb)
    save_rulebook(rb)
    return rb


def predict_rules(rb: dict) -> dict:
    """Generalise her observed rules into things she'll likely also flag. User decisions are kept."""
    keep = [r for r in rb["rules"] if r["basis"] == "observed" or r.get("decided")]
    rejected = [r["rule"] for r in rb["rules"] if r.get("decided") and r["status"] == "rejected"]
    try:
        res = llm.chat_json(
            "You are a senior video post-production reviewer who studies a manager's feedback to predict what else she will reject. Return JSON only.",
            "Context: short vertical reels (60-120s) for IIM Bangalore's Faculty Development Programme. A professor talks to camera; "
            "editors add burned-in captions, AI-generated images, b-roll, animated slide graphics/title cards and a logo.\n"
            "She has APPROVED 15 reels made in this style - so hard cuts, AI images, slide graphics and a small corner logo are acceptable to her.\n\n"
            f"Rules she has actually enforced, with her exact words:\n{_rules_text(rb, 'observed')}\n\n"
            + (f"Rules she does NOT care about (rejected predictions - do not repeat or rephrase these):\n- " + "\n- ".join(rejected) + "\n\n" if rejected else "")
            + "Predict 10 further rules she has NOT written yet but would very likely enforce, judging by the standard her comments reveal "
            "(caption completeness, colour consistency between footage types, opening/story structure, visuals matching the words). "
            "Each must be something a manager notices just by watching the reel - write it plainly, in her register. "
            "No invented numeric specs (no LUFS, contrast ratios, millisecond thresholds). Do not contradict what she has approved. "
            "Spread across captions, grading, structure, relevance, animation/transitions, on-screen text, audio and ending. "
            "Confidence: how sure you are she'd flag it (0.3-0.85; nothing is certain until she confirms).\n"
            'Return {"rules": [{"id": "snake_case", "category": "...", "rule": "one sentence", "because": "which of her comments implies this", '
            '"confidence": 0.3-0.85}]}', max_tokens=3500)
        taken = {r["id"] for r in keep}
        for r in res.get("rules", []):
            if r.get("id") and r["id"] not in taken and r.get("rule"):
                keep.append({"id": r["id"], "category": r.get("category", "other"), "rule": r["rule"],
                             "because": r.get("because", ""), "confidence": float(r.get("confidence", 0.5)),
                             "basis": "predicted", "status": "active", "examples": []})
        rb["rules"] = keep
    except llm.LLMUnavailable:
        pass  # keep the previous predicted rules
    return rb


def decide_rule(rule_id: str, status: str) -> dict:
    rb = load_rulebook()
    for r in rb["rules"]:
        if r["id"] == rule_id:
            r["status"], r["decided"] = status, True
    save_rulebook(rb)
    return rb


# ---------- the note-writer ----------
SYSTEM = """You are Nidhi, the content manager who signs off final reels for IIM Bangalore's Faculty Development Programme.
You review the editor's export and write short, direct notes - casual, lowercase-ish, no fluff, one issue per note,
always with a timestamp in m.ss format (0.16 = 16 seconds, 1.05 = 65 seconds) and usually with the fix.
Plain words only - you never quote dB, LUFS or other technical figures.
Your past notes on OTHER reels, word for word (copy the style only - their timestamps and issues are not about this reel):
{examples}
Rules you enforce:
{observed}
Rules you very likely also care about (predicted from your past notes):
{predicted}
Return JSON only."""

TASK = """Reel {reel} (editor: {editor}), {duration:.0f}s, {w}x{h}.

HOW STRICT YOU ARE: of the {judged} reels you have judged, {approved} were Approved with no comment at all, and your
Corrections usually carry a single note. Be exactly that sparing: usually 0-3 notes, only things you'd genuinely send back.

TRANSCRIPT (seconds):
{transcript}

SHOTS (seconds | type | caption on screen | other text | what is shown | motion):
{shots}

AUTOMATED CHECK RESULTS (index: finding):
{findings}

Do the review:
1. Go through the automated results. Keep the real problems, drop false alarms (vision-model noise, nitpicks you'd never raise).
2. Compare non-professor shots with what is said at that time. Flag visuals_match_speech ONLY where the visual is clearly about a
   different subject than the words. Loose or metaphorical illustration is fine - your approved reels are full of it.
3. Flag anything else that clearly breaks one of your rules, but only with a concrete moment in the data above. Never raise caption
   sync, pacing or style in general terms - the data can't show those.
4. Write each note the way you write them, with the m.ss time inside the note text.
Return {{"verdict": "Approved" or "Correction", "summary": "one line for the editor",
"notes": [{{"t": start in SECONDS (e.g. 76 for 1.16), "end": end in SECONDS, "category": "...", "severity": "high|medium|low",
"basis": "observed|predicted|technical", "rule": "rule id", "note": "your note", "from_check": index or null}}]}}
Verdict is Correction if any high or medium note remains."""
MAX_NOTES = 8  # ponytail: hard ceiling in case the model ignores the calibration
CHECKED_RULES = {"captions_missing", "caption_typo", "open_with_professor", "grade_matches_delivery", "audio_present",
                 "audio_level", "audio_clipping", "dead_air", "audio_jump", "vertical_9x16", "full_hd",
                 "too_many_broll", "jarring_visuals", "no_negative_graphs"}


def _transcript_lines(tr: dict | None, chunk: float = 4.0) -> str:
    if not tr or not tr.get("words"):
        return "(no transcript)"
    lines, cur, start = [], [], None
    for w in tr["words"]:
        if start is None:
            start = w["start"]
        cur.append(w["word"])
        if w["end"] - start >= chunk:
            lines.append(f"[{start:.1f}-{w['end']:.1f}] {' '.join(cur)}")
            cur, start = [], None
    if cur:
        lines.append(f"[{start:.1f}-{tr['words'][-1]['end']:.1f}] {' '.join(cur)}")
    return "\n".join(lines)


def _shot_lines(facts: dict) -> str:
    seen = [v for v in facts["vision"] if not v.get("skipped")]
    out = []
    for s in facts["media"]["shots"]:
        vs = [v for v in seen if s["start"] <= v["t"] < s["end"]] or \
             [min(seen, key=lambda v: abs(v["t"] - s["start"]))] if seen else []
        if not vs:
            out.append(f"[{s['start']:.1f}-{s['end']:.1f}] (no vision)")
            continue
        v = vs[len(vs) // 2]
        caps = " / ".join(dict.fromkeys((x.get("caption") or "-") for x in vs))[:160]
        motion = next((x.get("motion") for x in vs if x.get("motion")), None)
        out.append(f"[{s['start']:.1f}-{s['end']:.1f}] {v.get('shot')} | {caps} | {(v.get('onscreen_text') or '-')[:80]} | "
                   f"{(v.get('description') or '')[:140]}" + (f" | {motion[:80]}" if motion else ""))
    return "\n".join(out[:45])


def _fix_times(n: dict) -> dict:
    """The m.ss stamp in the note text is what the editor reads - make t/end agree with it."""
    times = parse_times(n["note"])
    t = float(n.get("t") or 0)
    end = float(n.get("end") or t)
    if times:  # keep the model's end only if it is plausible seconds after the stamped start
        t, end = times[0], times[-1] if len(times) > 1 else (end if 0 <= end - times[0] < 15 else times[0])
    n["t"], n["end"] = t, max(t, end)
    return n


def write_review(facts: dict, meta: dict) -> dict:
    rb = load_rulebook()
    findings = facts["findings"]
    examples = "\n".join(f'- "{e["note"]}"' for r in rb["rules"] for e in r.get("examples", []))
    try:
        judged = [r for r in reels() if r["status"] in ("Approved", "Correction")]
    except Exception:
        judged = []
    try:
        res = llm.chat_json(
            SYSTEM.format(examples=examples, observed=_rules_text(rb, "observed"), predicted=_rules_text(rb, "predicted")),
            TASK.format(reel=meta.get("reel") or facts["file_id"][:8], editor=meta.get("editor") or "?",
                        duration=facts["media"]["duration"], w=facts["media"]["width"], h=facts["media"]["height"],
                        judged=len(judged) or 22, approved=sum(r["status"] == "Approved" for r in judged) or 15,
                        transcript=_transcript_lines(facts["transcript"]), shots=_shot_lines(facts),
                        findings="\n".join(f"{i}: [{f['rule']}, {f['severity']}] {f['note']} ({f['evidence']})"
                                           for i, f in enumerate(findings)) or "(none)"))
        notes = [_fix_times(n) for n in res.get("notes", []) if isinstance(n, dict) and n.get("note")]
        rank = {"high": 0, "medium": 1, "low": 2}
        for n in notes:  # a note built on a check keeps its rule id and can't be escalated above it
            fc = n.get("from_check")
            if isinstance(fc, int) and 0 <= fc < len(findings):
                n["rule"], n["basis"] = findings[fc]["rule"], findings[fc]["basis"]
                if rank.get(n.get("severity"), 1) < rank[findings[fc]["severity"]]:
                    n["severity"] = findings[fc]["severity"]
        # rules the automated checks measure need a matching check result - otherwise the model is guessing
        checked = {f["rule"] for f in findings} | CHECKED_RULES
        proposed = len(notes)
        notes = [n for n in notes if n.get("rule") not in checked or (
            isinstance(n.get("from_check"), int) and 0 <= n["from_check"] < len(findings)
            and findings[n["from_check"]]["rule"] == n["rule"])]
        notes = sorted(notes, key=lambda n: rank.get(n.get("severity"), 3))[:MAX_NOTES]
        used = {n.get("from_check") for n in notes}
        summary, writer = res.get("summary", ""), "groq"
        if len(notes) < proposed:  # the model's summary may mention notes we just removed
            summary = "; ".join(n["note"] for n in notes[:3]) or "No issues found."
    except (llm.LLMUnavailable, AttributeError, TypeError, ValueError):
        notes = [{**f, "from_check": i} for i, f in enumerate(findings) if f["rule"] != "vision_issue"]
        used, writer = set(range(len(findings))), "fallback"
        summary = "Automated checks only (Groq writer unavailable) - notes are templated."
    if any(n.get("severity") in ("high", "medium") for n in notes):
        verdict = "Correction"
    else:  # only claim Approved when every check actually ran
        verdict = "Incomplete" if facts.get("retry_at") or facts["skipped"] else "Approved"
    return {
        "reel": meta.get("reel"), "editor": meta.get("editor"), "url": facts["url"], "file_id": facts["file_id"],
        "verdict": verdict, "summary": summary, "notes": sorted(notes, key=lambda n: n["t"]),
        "dropped": [f for i, f in enumerate(findings) if i not in used],
        "skipped": facts["skipped"], "writer": writer, "partial": bool(facts.get("retry_at")), "vision_source": facts.get("vision_source"), "retry_at": facts.get("retry_at", 0),
        "media": {k: facts["media"][k] for k in ("duration", "width", "height", "fps", "cuts")},
        "frames": [{"t": v["t"], "file": v["file"], "caption": v.get("caption"), "shot": v.get("shot")}
                   for v in facts["vision"] if not v.get("skipped")],
        "transcript": (facts["transcript"] or {}).get("text", ""),
        "transcript_source": (facts["transcript"] or {}).get("source"),
        "created": time.strftime("%Y-%m-%d %H:%M"),
    }


def run(url: str, meta: dict | None = None, progress=None) -> dict:
    if meta is None:
        fid = review.file_id(url)
        try:
            meta = next((r for r in reels() if r["file_id"] == fid), {})
        except Exception:  # sheet unreachable and no cache: review still runs, just without reel name/editor
            meta = {}
    facts = review.review(url, progress)
    if progress:
        progress("writing", 0)
    rep = write_review(facts, meta)
    p = review.CACHE / facts["file_id"] / "report.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rep, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)
    return rep


# ---------- backtest ----------
def backtest(progress=None) -> dict:
    """Run the agent on every reel Nidhi has already judged and compare with her verdict/notes."""
    rb = load_rulebook()
    rule_of = {e["reel"]: r["id"] for r in rb["rules"] for e in r.get("examples", [])}
    results = []
    judged = [r for r in reels() if r["status"] in ("Approved", "Correction")]
    for i, r in enumerate(judged):
        if not r["link"]:
            results.append({**r, "outcome": "no video available"})
            continue
        if progress:
            progress(f"backtest {r['reel']} ({i + 1}/{len(judged)})", i / len(judged))
        rep = run(r["link"], r)
        times, rule = parse_times(r["notes"]), rule_of.get(r["reel"])
        hits = [n for n in rep["notes"] if n.get("rule") == rule and
                (not times or any(n["t"] - 4 <= t <= n["end"] + 4 for t in times))]
        fixed = (r["version"] or 1) > 1  # a _v02 file in the folder = editor already re-exported after her note
        if rep["partial"] and not hits and r["status"] != "Approved":
            outcome = "pending (vision quota)"  # can't call it fixed/missed until every frame has been looked at
        elif r["status"] == "Approved":
            outcome = "agrees" if rep["verdict"] == "Approved" else "extra flags"
        elif fixed:
            outcome = "fix confirmed" if not hits else "issue still present"
        else:
            outcome = "caught" if hits else "missed"
        results.append({"reel": r["reel"], "status": r["status"], "her_note": r["notes"], "version": r["version"],
                        "agent_verdict": rep["verdict"], "matching_notes": [n["note"] for n in hits],
                        "agent_notes": len(rep["notes"]), "outcome": outcome, "partial": rep["partial"]})
    out = {"ran": time.strftime("%Y-%m-%d %H:%M"), "results": results,
           "partial": any(x.get("partial") for x in results)}
    (DATA / "backtest.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    return out


if __name__ == "__main__":
    assert parse_times("0,37 sec to 0.46 sec visuals") == [37, 46]
    assert parse_times("Captions missing in 0.16second") == [16]
    assert parse_times("Grading vs delivery not good on the scooter at 0.07") == [7]
    for r in reels():
        print(f"{r['reel']:8} {r['status']:14} {r['editor']:8} v{r['version'] or '-'}  {r['file_id'] or 'NO VIDEO'}")
