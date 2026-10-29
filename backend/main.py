"""FDP Reel Reviewer API: queue reels, run the Nidhi review agent, serve reports and the static frontend."""
import os
import socket
import ipaddress
from urllib.parse import urlparse
import re
import json
import time
import uuid
import queue
import threading
import traceback
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import nidhi
import review
import gemini
import auth
import revisions

app = FastAPI(title="FDP Reel Reviewer", docs_url=None, redoc_url=None, openapi_url=None)
app.middleware("http")(auth.middleware)
app.include_router(auth.router)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["*"], allow_headers=["*"])
MAX_URLS = 50       # per request
MAX_PENDING = 200   # queued/running/waiting jobs overall


def _safe_url(u: str):
    """SSRF guard: http(s) only, and never a private/loopback/link-local host."""
    p = urlparse(u)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HTTPException(400, f"Not a valid http(s) link: {u[:80]}")
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(p.hostname, None)}
    except OSError:
        return  # DNS failure is non-fatal; the download stage reports it
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HTTPException(400, "Links to private or local addresses are not allowed.")

JOBS_FILE = review.DATA / "jobs.json"
review.DATA.mkdir(exist_ok=True)
jobs: dict = json.loads(JOBS_FILE.read_text(encoding="utf-8")) if JOBS_FILE.exists() else {}
lock = threading.Lock()
work: "queue.Queue[str]" = queue.Queue()


def save():
    with lock:
        tmp = JOBS_FILE.with_suffix(".tmp")
        for i in range(20):  # OneDrive/antivirus can hold jobs.json for a moment on Windows
            try:
                tmp.write_text(json.dumps(jobs, indent=1, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, JOBS_FILE)  # atomic: a crash mid-write never corrupts the job list
                return
            except PermissionError:
                time.sleep(0.25)
        print("[jobs] could not write jobs.json (file locked) - will retry on the next update", flush=True)


def update(jid: str, **kw):
    jobs[jid].update(kw, updated=time.time())
    save()


MAX_RESUMES = 48  # partial jobs re-run when the vision quota frees; it trickles back, so one reel may need several


def resume_later(jid: str, at: float):
    update(jid, status="waiting", stage="waiting for Groq vision quota", retry_at=at)
    threading.Timer(max(0, at - time.time()) + 5, lambda: (update(jid, status="queued"), work.put(jid))).start()


def worker():
    # ponytail: one worker on purpose - the free tier is 8K tokens/min per model, parallel reels just queue on 429s
    while True:
        jid = work.get()
        job = jobs.get(jid)
        if not job or job["status"] not in ("queued", "running"):
            continue
        update(jid, status="running")
        prog = lambda stage, pct: update(jid, stage=stage, pct=round(pct, 2))
        try:
            if job["kind"] == "review":
                rep = nidhi.run(job["url"], job.get("meta"), prog)
                update(jid, status="done", stage="done", pct=1, verdict=rep["verdict"], notes=len(rep["notes"]),
                       reel=rep.get("reel") or job.get("reel"), writer=rep["writer"], partial=rep["partial"])
                if rep["partial"] and job.get("resumes", 0) < MAX_RESUMES:
                    update(jid, resumes=job.get("resumes", 0) + 1)
                    resume_later(jid, rep["retry_at"])
            elif job["kind"] == "backtest":
                bt = nidhi.backtest(prog)
                update(jid, status="done", stage="done", pct=1, partial=bt["partial"])
                if bt["partial"] and job.get("resumes", 0) < MAX_RESUMES:
                    update(jid, resumes=job.get("resumes", 0) + 1)
                    resume_later(jid, nidhi.llm.available_at(nidhi.llm.VISION_MODELS) or time.time() + 600)
            elif job["kind"] == "learn":
                rb = nidhi.learn()
                update(jid, status="done", stage="done", pct=1, rules=len(rb["rules"]))
        except Exception as e:
            traceback.print_exc()
            update(jid, status="failed", error=f"{type(e).__name__}: {e}"[:600])


def enqueue(kind: str, **kw) -> dict:
    jid = uuid.uuid4().hex[:10]
    jobs[jid] = {"id": jid, "kind": kind, "status": "queued", "stage": "queued", "pct": 0,
                 "created": time.time(), "updated": time.time(), **kw}
    save()
    work.put(jid)
    return jobs[jid]


# resume anything interrupted by a restart (finished stages are cached on disk, so this is cheap)
for j in sorted(jobs.values(), key=lambda j: j["created"]):
    if j["status"] in ("queued", "running"):
        j["status"] = "queued"
        work.put(j["id"])
save()
for j in jobs.values():
    if j["status"] == "waiting":
        resume_later(j["id"], j.get("retry_at", 0))
threading.Thread(target=worker, daemon=True).start()


def _safe_id(fid: str) -> str:
    if not re.fullmatch(r"[\w-]{8,64}", fid):
        raise HTTPException(400, "bad id")
    return fid


def _report(fid: str) -> Optional[dict]:
    p = review.CACHE / fid / "report.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


# ---------- reels & reviews ----------
@app.get("/api/reels")
def get_reels():
    try:
        rows = nidhi.reels()
    except Exception as e:
        raise HTTPException(503, f"Could not read the review sheet and no cached copy exists: {e}")
    active = {j.get("file_id"): j for j in jobs.values() if j["kind"] == "review" and j["status"] in ("queued", "running", "waiting")}
    rev_map = revisions.get_all_revisions(refresh_from_reports=True)
    for r in rows:
        rep = _report(r["file_id"]) if r["file_id"] else None
        r["agent"] = {"verdict": rep["verdict"], "notes": len(rep["notes"]), "created": rep["created"]} if rep else None
        r["job"] = active.get(r["file_id"])
        key = r["reel"] if r["reel"] and r["reel"] != "-" else r.get("file_id")
        rev = rev_map.get(key)
        if rev:
            r["revision"] = {
                "round": rev.get("round", 1),
                "status": rev.get("status", "pending_fixes"),
                "total": len(rev.get("notes", [])),
                "editor_done": sum(1 for n in rev.get("notes", []) if n.get("editor_done")),
                "nidhi_verified": sum(1 for n in rev.get("notes", []) if n.get("nidhi_verified")),
            }
        else:
            r["revision"] = None
    return {"reels": rows}


@app.post("/api/sync")
def sync_data():
    """Force fresh fetch from Google Sheets and Drive folder, and sync revision items."""
    try:
        rows = nidhi.sync_sheet_and_drive()
        revisions.get_all_revisions(refresh_from_reports=True)
        return {"ok": True, "count": len(rows), "timestamp": time.time()}
    except Exception as e:
        raise HTTPException(502, f"Failed to sync with Google Sheet: {e}")


class ReviewRequest(BaseModel):
    urls: List[str] = []
    reels: List[str] = []
    pending: bool = False   # queue every "Yet to review" row
    rerun: bool = False     # regenerate notes even if a report exists (cached media/transcript/vision are reused)


@app.post("/api/review")
def start_review(req: ReviewRequest):
    rows = []
    try:
        rows = nidhi.reels()
    except Exception:
        pass
    targets = []
    for u in req.urls:
        for u2 in re.split(r"[\s,]+", u.strip()):
            if u2:
                _safe_url(u2)
                fid = review.file_id(u2)
                targets.append((u2, next((r for r in rows if r["file_id"] == fid), {"reel": None})))
    wanted = set(req.reels)
    for r in rows:
        if r["link"] and (r["reel"] in wanted or (req.pending and r["status"].lower() == "yet to review")):
            targets.append((r["link"], r))
    if not targets:
        raise HTTPException(400, "Nothing to review - paste Drive/YouTube links or pick reels that have a video.")
    if len(targets) > MAX_URLS and not req.pending:
        raise HTTPException(400, f"Too many links in one request (max {MAX_URLS}).")
    if sum(j["status"] in ("queued", "running", "waiting") for j in jobs.values()) + len(targets) > MAX_PENDING:
        raise HTTPException(429, "Queue is full - wait for some reviews to finish.")

    busy = {j.get("file_id") for j in jobs.values() if j["kind"] == "review" and j["status"] in ("queued", "running", "waiting")}
    queued = []
    for url, meta in targets:
        fid = review.file_id(url)
        if fid in busy:
            continue
        busy.add(fid)
        if req.rerun and (review.CACHE / fid / "report.json").exists():
            (review.CACHE / fid / "report.json").unlink()
        queued.append(enqueue("review", url=url, file_id=fid, reel=meta.get("reel"), meta=meta or None))
    return {"queued": queued}


@app.get("/api/jobs")
def get_jobs():
    return {"jobs": sorted(jobs.values(), key=lambda j: j["created"], reverse=True)[:200]}


@app.get("/api/usage")
def get_usage():
    return {"gemini": gemini.status(),
            "groq_parked": {m: round(t - time.time()) for m, t in nidhi.llm._exhausted.items() if t > time.time()}}


class Settings(BaseModel):
    daily_reels: int


@app.post("/api/settings")
def set_settings(s: Settings):
    if not 0 <= s.daily_reels <= 1000:
        raise HTTPException(400, "daily_reels must be 0-1000 (0 pauses Gemini)")
    gemini.set_daily_reels(s.daily_reels)
    return get_usage()


@app.get("/api/report/{fid}")
def get_report(fid: str):
    rep = _report(_safe_id(fid))
    if not rep:
        raise HTTPException(404, "No report yet")
    return rep


@app.get("/api/frame/{fid}/{name}")
def get_frame(fid: str, name: str):
    if not re.fullmatch(r"[\d.]+\.jpg", name):
        raise HTTPException(400, "bad frame")
    p = review.CACHE / _safe_id(fid) / "frames" / name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/video/{fid}")
def get_video(fid: str):
    vids = [p for p in (review.CACHE / _safe_id(fid)).glob("video.*") if p.suffix not in (".part", ".ytdl")]
    if not vids:
        raise HTTPException(404)
    return FileResponse(vids[0])


# ---------- rulebook & backtest ----------
@app.get("/api/rulebook")
def get_rulebook():
    return nidhi.load_rulebook()


@app.post("/api/rulebook/learn")
def learn():
    return enqueue("learn")


class Decision(BaseModel):
    status: str


@app.post("/api/rulebook/{rule_id}")
def decide(rule_id: str, d: Decision):
    if d.status not in ("active", "rejected"):
        raise HTTPException(400, "status must be active or rejected")
    return nidhi.decide_rule(rule_id, d.status)


@app.post("/api/backtest")
def start_backtest():
    return enqueue("backtest")


@app.get("/api/backtest")
def get_backtest():
    p = review.DATA / "backtest.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"results": []}


# ---------- notes repository & revisions ----------
@app.get("/api/revisions")
def list_revisions():
    return {"revisions": revisions.get_all_revisions(refresh_from_reports=True)}


class ToggleRequest(BaseModel):
    key: str
    note_id: str
    field: str
    value: bool
    comment: Optional[str] = None


@app.post("/api/revisions/toggle")
def toggle_revision_note(req: ToggleRequest):
    try:
        return revisions.toggle_note_field(req.key, req.note_id, req.field, req.value, req.comment)
    except KeyError as e:
        raise HTTPException(404, str(e))


class AdvanceRequest(BaseModel):
    key: str


@app.post("/api/revisions/advance")
def advance_revision_round(req: AdvanceRequest):
    try:
        return revisions.advance_round(req.key)
    except KeyError as e:
        raise HTTPException(404, str(e))


class CustomNoteRequest(BaseModel):
    key: str
    text: str
    t: float = 0.0
    category: str = "custom"
    severity: str = "medium"
    author: str = "editor"


@app.post("/api/revisions/note")
def add_revision_note(req: CustomNoteRequest):
    try:
        return revisions.add_custom_note(req.key, req.text, req.t, req.category, req.severity, req.author)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.get("/api/revisions/{key}/candidates")
def get_v2_candidates(key: str):
    candidates = nidhi.find_v2_candidates(key)
    rev_data = revisions.get_all_revisions(refresh_from_reports=False)
    locked = rev_data.get(key, {}).get("v2_video")
    return {"candidates": candidates, "locked": locked}


class ConfirmV2Request(BaseModel):
    key: str
    file_id: str
    name: str = ""
    url: str = ""
    start_review: bool = False


@app.post("/api/revisions/confirm-v2")
def confirm_v2(req: ConfirmV2Request):
    try:
        updated = revisions.confirm_v2_video(req.key, req.file_id, req.name, req.url)
        job = None
        if req.start_review:
            meta = {"reel": req.key}
            try:
                for r in nidhi.reels():
                    if r["reel"] == req.key:
                        meta = r
                        break
            except Exception:
                pass
            target_url = req.url or f"https://drive.google.com/file/d/{req.file_id}/view"
            job = enqueue("review", url=target_url, reel=req.key, file_id=req.file_id, meta=meta, rerun=True)
        return {"ok": True, "revision": updated, "job": job}
    except Exception as e:
        raise HTTPException(400, str(e))


# ---------- static frontend (built with `npm run build` -> frontend/out) ----------
OUT = os.path.join(os.path.dirname(__file__), "..", "frontend", "out")
if os.path.isdir(os.path.join(OUT, "_next")):
    app.mount("/_next", StaticFiles(directory=os.path.join(OUT, "_next")), name="next-static")


@app.get("/{full_path:path}")
def serve_frontend(full_path: str):
    if not os.path.isdir(OUT):
        return {"message": "API is running. Build the frontend (cd frontend && npm run build) or use `npm run dev`."}
    for cand in (os.path.join(OUT, full_path), os.path.join(OUT, f"{full_path}.html"), os.path.join(OUT, full_path, "index.html")):
        if full_path and ".." not in full_path and os.path.isfile(cand):
            return FileResponse(cand)
    return FileResponse(os.path.join(OUT, "index.html"))


if __name__ == "__main__":
    import uvicorn
    _host = os.environ.get("HOST", "127.0.0.1")
    auth.check_startup(_host)
    uvicorn.run(app, host=_host, port=int(os.environ.get("PORT", 8000)), access_log=False)
