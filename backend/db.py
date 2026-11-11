"""Lightweight PostgreSQL / Neon JSONB persistence mirror for ephemeral containers (Render 512 MB tier).

When DATABASE_URL (or NEON_DATABASE_URL / POSTGRES_URL) is set:
  - hydrate(DATA) restores revisions, rulebook, custom_reels, settings, usage, jobs, reports & cached stages onto disk at boot.
  - put(key, val) / delete(key) mirrors every update straight to Postgres (with auto-retry for Neon serverless wakeups).
When unset, all functions are fast no-ops and local JSON files work unchanged.
"""
import json
import os
import threading
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))
load_dotenv()

_raw_url = (
    os.environ.get("DATABASE_URL")
    or os.environ.get("NEON_DATABASE_URL")
    or os.environ.get("POSTGRES_URL")
    or ""
).strip()
if _raw_url.startswith("postgres://"):
    _raw_url = "postgresql://" + _raw_url[len("postgres://"):]
DB_URL = _raw_url

_lock = threading.Lock()
_ok = False
_TOP_KEYS = ("revisions", "rulebook", "custom_reels", "settings", "usage", "backtest", "jobs")


def configured() -> bool:
    return bool(DB_URL)


def status() -> dict:
    return {"configured": bool(DB_URL), "connected": _ok}


def _connect():
    import psycopg
    try:
        return psycopg.connect(DB_URL, autocommit=True, connect_timeout=10)
    except Exception:
        if "channel_binding=require" in DB_URL:
            return psycopg.connect(
                DB_URL.replace("channel_binding=require", "channel_binding=prefer"),
                autocommit=True, connect_timeout=10,
            )
        raise


def _exec(fn):
    global _ok
    if not DB_URL:
        return None
    for attempt in range(2):
        try:
            with _lock, _connect() as conn:
                res = fn(conn)
                _ok = True
                return res
        except Exception as e:
            if attempt == 0:
                time.sleep(0.4)
                continue
            _ok = False
            print(f"[db] warning: {type(e).__name__}: {str(e)[:160]}", flush=True)
    return None


def put(key: str, val) -> None:
    if not DB_URL:
        return
    payload = json.dumps(val, ensure_ascii=False)
    now = time.time()
    _exec(lambda c: c.execute(
        "INSERT INTO kv_store (key, val, updated_at) VALUES (%s, %s::jsonb, %s) "
        "ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val, updated_at = EXCLUDED.updated_at",
        (key, payload, now),
    ))


def delete(key: str) -> None:
    if not DB_URL:
        return
    _exec(lambda c: c.execute("DELETE FROM kv_store WHERE key = %s", (key,)))


def _write_atomic(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def hydrate(data_dir: Path) -> int:
    """Create schema if needed, pull persisted JSON state onto local disk, and seed initial files on first connect."""
    if not DB_URL:
        return 0
    data_dir.mkdir(parents=True, exist_ok=True)

    def _init_and_fetch(conn):
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kv_store ("
            "key TEXT PRIMARY KEY, val JSONB NOT NULL, updated_at DOUBLE PRECISION NOT NULL)"
        )
        return conn.execute("SELECT key, val FROM kv_store").fetchall()

    rows = _exec(_init_and_fetch)
    if rows is None:
        return 0

    seen = set()
    for key, val in rows:
        seen.add(key)
        if isinstance(val, str):
            val = json.loads(val)
        if key in _TOP_KEYS:
            _write_atomic(data_dir / f"{key}.json", val)
        elif key.startswith("report:"):
            fid = key.split(":", 1)[1]
            if fid:
                _write_atomic(data_dir / "cache" / fid / "report.json", val)
        elif key.startswith("stage:"):
            parts = key.split(":", 2)
            if len(parts) == 3 and parts[1] and parts[2]:
                _write_atomic(data_dir / "cache" / parts[1] / f"{parts[2]}.json", val)

    # First-time DB bootstrap: push seed rulebook & revisions if DB doesn't have them yet
    for seed_key in ("rulebook", "revisions"):
        sp = data_dir / f"{seed_key}.json"
        if seed_key not in seen and sp.exists():
            try:
                put(seed_key, json.loads(sp.read_text(encoding="utf-8")))
            except Exception:
                pass

    print(f"[db] hydrated {len(rows)} records from PostgreSQL", flush=True)
    return len(rows)


if __name__ == "__main__":
    assert status()["configured"] == bool(DB_URL)
    print("db.py self-check ok;", status())

