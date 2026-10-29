"""Revision Tracker & Notes Repository:
Manages multi-round reviews (Review 1, Review 2), dual checklists for Editor and Nidhi,
and persistent tracking of corrections across reels.
"""
import json
import time
import uuid
from pathlib import Path
from typing import Dict, Any, Optional

import review
import nidhi

DATA = review.DATA
CACHE = review.CACHE
REVISIONS_FILE = DATA / "revisions.json"


def _load_raw() -> dict:
    if REVISIONS_FILE.exists():
        try:
            return json.loads(REVISIONS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_raw(data: dict):
    DATA.mkdir(exist_ok=True)
    tmp = REVISIONS_FILE.with_suffix(".tmp")
    for _ in range(10):
        try:
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(REVISIONS_FILE)
            return
        except OSError:
            time.sleep(0.05)


def _compute_status(notes: list, round_num: int, current_status: str = "") -> str:
    """Computes status: pending_fixes, ready_for_review, approved, or unreviewed."""
    if not notes:
        if current_status == "unreviewed":
            return "unreviewed"
        return "approved"
    all_nidhi = all(n.get("nidhi_verified") for n in notes)
    if all_nidhi:
        return "approved"
    all_editor = all(n.get("editor_done") for n in notes)
    if all_editor:
        return "ready_for_review"
    return "pending_fixes"


def _notes_from_report(rep: dict) -> list:
    return [{
        "id": f"n_{i}_{int(n.get('t', 0))}",
        "t": n.get("t", 0),
        "end": n.get("end", n.get("t", 0)),
        "note": n.get("note", ""),
        "category": n.get("category", "general"),
        "severity": n.get("severity", "medium"),
        "basis": n.get("basis", "observed"),
        "rule": n.get("rule", ""),
        "editor_done": False,
        "editor_comment": "",
        "nidhi_verified": False,
        "nidhi_comment": "",
    } for i, n in enumerate(rep.get("notes", []))]


def sync_report_to_revision(rep: dict):
    """Syncs a newly completed AI review report directly into revisions.json."""
    fid = rep.get("file_id") or ""
    reel_name = rep.get("reel") or fid[:8]
    key = reel_name if reel_name and reel_name != "-" else fid
    if not key:
        return
    data = _load_raw()
    new_notes = _notes_from_report(rep)
    if key not in data:
        data[key] = {
            "reel": reel_name,
            "file_id": fid,
            "report_file_id": fid,
            "editor": rep.get("editor") or "",
            "round": 1,
            "status": _compute_status(new_notes, 1),
            "notes": new_notes,
            "history": [],
            "url": rep.get("url") or "",
            "created_at": rep.get("created") or time.strftime("%Y-%m-%d %H:%M"),
            "updated_at": time.time(),
        }
    else:
        entry = data[key]
        if fid:
            entry["file_id"] = fid
            entry["report_file_id"] = fid
        if rep.get("editor") and not entry.get("editor"):
            entry["editor"] = rep.get("editor")
        if rep.get("url"):
            entry["url"] = rep.get("url")
        manual_notes = [n for n in entry.get("notes", []) if n.get("basis") == "manual"]
        entry["notes"] = manual_notes + new_notes
        entry["status"] = _compute_status(entry["notes"], entry.get("round", 1))
        entry["updated_at"] = time.time()
    _save_raw(data)


def get_all_revisions(refresh_from_reports: bool = True) -> Dict[str, Any]:
    """Returns all tracked reel revisions, populating any newly finished AI reports and sheet reels."""
    data = _load_raw()
    updated = False

    # 1. Ensure all reels from Google Sheet are represented first
    if refresh_from_reports:
        try:
            sheet_reels = nidhi.reels()
            for r in sheet_reels:
                key = r.get("reel")
                if not key:
                    continue
                fid = r.get("file_id") or ""
                link = r.get("link") or ""
                editor = r.get("editor") or ""
                sheet_st = (r.get("status") or "").strip().lower()

                if key not in data:
                    init_st = "approved" if "approved" in sheet_st else "unreviewed"
                    data[key] = {
                        "reel": key,
                        "file_id": fid,
                        "editor": editor,
                        "round": 1,
                        "status": init_st,
                        "notes": [],
                        "history": [],
                        "url": link,
                        "sheet_status": r.get("status") or "",
                        "created_at": time.strftime("%Y-%m-%d %H:%M"),
                        "updated_at": time.time(),
                    }
                    updated = True
                else:
                    entry = data[key]
                    if not entry.get("file_id") and fid:
                        entry["file_id"] = fid
                        updated = True
                    if not entry.get("editor") and editor:
                        entry["editor"] = editor
                        updated = True
                    if not entry.get("url") and link:
                        entry["url"] = link
                        updated = True
                    if not entry.get("sheet_status") and r.get("status"):
                        entry["sheet_status"] = r.get("status")
                        updated = True
        except Exception:
            pass

    # 2. Sync each tracked reel against its current file_id's report.json
    if refresh_from_reports and CACHE.exists():
        for key, entry in list(data.items()):
            fid = entry.get("file_id")
            if not fid:
                continue
            rep_file = CACHE / fid / "report.json"
            if not rep_file.exists():
                continue
            try:
                rep = json.loads(rep_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            if entry.get("status") == "unreviewed" or (not entry.get("notes") and entry.get("report_file_id") != fid):
                notes = _notes_from_report(rep)
                entry["notes"] = notes
                entry["report_file_id"] = fid
                entry["status"] = _compute_status(notes, entry.get("round", 1))
                updated = True

        # 3. Also include any ad-hoc reports in CACHE not in the sheet
        known_fids = {e.get("file_id") for e in data.values() if e.get("file_id")}
        for d in CACHE.iterdir():
            if not d.is_dir() or d.name in known_fids:
                continue
            rep_file = d / "report.json"
            if not rep_file.exists():
                continue
            try:
                rep = json.loads(rep_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            fid = rep.get("file_id") or d.name
            reel_name = rep.get("reel") or fid[:8]
            key = reel_name if reel_name and reel_name != "-" else fid
            if key not in data:
                notes = _notes_from_report(rep)
                data[key] = {
                    "reel": reel_name,
                    "file_id": fid,
                    "report_file_id": fid,
                    "editor": rep.get("editor") or "",
                    "round": 1,
                    "status": _compute_status(notes, 1),
                    "notes": notes,
                    "history": [],
                    "url": rep.get("url") or "",
                    "created_at": rep.get("created") or time.strftime("%Y-%m-%d %H:%M"),
                    "updated_at": time.time(),
                }
                updated = True

    if updated:
        _save_raw(data)

    return data


def toggle_note_field(key: str, note_id: str, field: str, value: bool, comment: Optional[str] = None) -> dict:
    """Toggles either 'editor_done' or 'nidhi_verified' on a note."""
    data = get_all_revisions(refresh_from_reports=False)
    if key not in data:
        raise KeyError(f"Reel '{key}' not found in revision tracking.")

    entry = data[key]
    target_note = next((n for n in entry["notes"] if n["id"] == note_id), None)
    if not target_note:
        raise KeyError(f"Note '{note_id}' not found.")

    if field in ("editor_done", "nidhi_verified"):
        target_note[field] = bool(value)
        if field == "editor_done" and comment is not None:
            target_note["editor_comment"] = comment
        elif field == "nidhi_verified" and comment is not None:
            target_note["nidhi_comment"] = comment

    entry["status"] = _compute_status(entry["notes"], entry.get("round", 1))
    entry["updated_at"] = time.time()
    _save_raw(data)
    return entry


def advance_round(key: str) -> dict:
    """Advances a reel from Review 1 -> Review 2, archiving completed round notes into history."""
    data = get_all_revisions(refresh_from_reports=False)
    if key not in data:
        raise KeyError(f"Reel '{key}' not found.")

    entry = data[key]
    current_round = entry.get("round", 1)

    # Archive current round (copy note dicts so Round 2 resets don't mutate history)
    history_item = {
        "round": current_round,
        "completed_at": time.strftime("%Y-%m-%d %H:%M"),
        "notes": [dict(n) for n in entry["notes"]],
        "total": len(entry["notes"]),
        "editor_done": sum(1 for n in entry["notes"] if n.get("editor_done")),
        "nidhi_verified": sum(1 for n in entry["notes"] if n.get("nidhi_verified")),
    }
    entry.setdefault("history", []).append(history_item)

    # Prepare Round 2: Keep unverified notes as fresh copies for review 2
    unverified = [{**n, "editor_done": False, "nidhi_verified": False}
                  for n in entry["notes"] if not n.get("nidhi_verified")]

    entry["round"] = current_round + 1
    entry["notes"] = unverified
    entry["status"] = _compute_status(unverified, entry["round"])
    entry["updated_at"] = time.time()

    _save_raw(data)
    return entry


def add_custom_note(key: str, text: str, t: float = 0.0, category: str = "custom", severity: str = "medium", author: str = "editor") -> dict:
    """Adds a custom manual note to a reel's active checklist."""
    data = get_all_revisions(refresh_from_reports=False)
    if key not in data:
        raise KeyError(f"Reel '{key}' not found.")

    entry = data[key]
    note_id = f"custom_{int(time.time())}_{uuid.uuid4().hex[:4]}"
    new_note = {
        "id": note_id,
        "t": t,
        "end": t,
        "note": text.strip(),
        "category": category,
        "severity": severity,
        "basis": "manual",
        "rule": "custom_note",
        "editor_done": (author == "editor"),
        "editor_comment": "",
        "nidhi_verified": False,
        "nidhi_comment": "",
    }
    entry["notes"].append(new_note)
    entry["status"] = _compute_status(entry["notes"], entry.get("round", 1))
    entry["updated_at"] = time.time()
    _save_raw(data)
    return entry


def confirm_v2_video(key: str, file_id: str, name: str = "", url: str = "", start_round: bool = True) -> dict:
    """Permanently locks and binds the confirmed v2 video for this reel."""
    data = get_all_revisions(refresh_from_reports=False)
    if key not in data:
        data[key] = {
            "reel": key,
            "file_id": file_id,
            "editor": "",
            "round": 1,
            "status": "pending_fixes",
            "notes": [],
            "history": [],
            "url": url,
            "created_at": time.strftime("%Y-%m-%d %H:%M"),
            "updated_at": time.time(),
        }

    entry = data[key]
    v2_info = {
        "file_id": file_id,
        "name": name or f"{key}_v2.mp4",
        "url": url or f"https://drive.google.com/file/d/{file_id}/view",
        "confirmed": True,
        "confirmed_at": time.strftime("%Y-%m-%d %H:%M"),
    }
    entry["v2_video"] = v2_info
    entry["file_id"] = file_id
    entry["url"] = v2_info["url"]

    if start_round and entry.get("round", 1) < 2:
        entry = advance_round(key)
        # re-attach v2_video after advance
        entry["v2_video"] = v2_info
        entry["file_id"] = file_id
        entry["url"] = v2_info["url"]
        data = get_all_revisions(refresh_from_reports=False)
        data[key] = entry

    entry["updated_at"] = time.time()
    _save_raw(data)
    return entry

