"""Google sign-in + email allowlist. Fail-closed: the server refuses to listen publicly without it.

Flow: browser gets a Google ID token (Google Identity Services) -> POST /auth/login -> we verify the token
signature/audience/expiry with Google's keys, check the email against ALLOWED_EMAILS, and set a signed,
HttpOnly, SameSite session cookie. Every /api/* call is then checked by `middleware`.
"""
import os
import time
import hmac
import base64
import hashlib
import secrets
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
ALLOWED = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "12"))
COOKIE = "rr_session"
_secret = os.environ.get("SESSION_SECRET", "")
if not _secret:
    _secret = secrets.token_urlsafe(48)  # per-process: sessions reset on restart (set SESSION_SECRET to persist)
SECRET = _secret.encode()
ENABLED = bool(CLIENT_ID)

router = APIRouter()


def check_startup(host: str):
    """Never expose the API publicly without auth, and never with auth but an empty allowlist."""
    local = host in ("127.0.0.1", "localhost", "::1")
    if not ENABLED and not local:
        raise SystemExit("Refusing to start: HOST is public but GOOGLE_CLIENT_ID is not set (auth disabled).")
    if ENABLED and not ALLOWED:
        raise SystemExit("Refusing to start: GOOGLE_CLIENT_ID is set but ALLOWED_EMAILS is empty.")


def _sign(msg: str) -> str:
    return base64.urlsafe_b64encode(hmac.new(SECRET, msg.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def make_token(email: str) -> str:
    body = f"{email}|{int(time.time()) + SESSION_HOURS * 3600}"
    return base64.urlsafe_b64encode(body.encode()).decode().rstrip("=") + "." + _sign(body)


def read_token(tok: str | None) -> str | None:
    try:
        b64, sig = (tok or "").split(".")
        body = base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode()
        if not hmac.compare_digest(sig, _sign(body)):
            return None
        email, exp = body.rsplit("|", 1)
        if int(exp) < time.time() or email.lower() not in ALLOWED:  # allowlist re-checked on every request
            return None
        return email
    except Exception:
        return None


def current_user(request: Request) -> str | None:
    return read_token(request.cookies.get(COOKIE))


async def middleware(request: Request, call_next):
    """Protect the whole API. The static frontend is public JS only; it shows the login screen itself."""
    if ENABLED and request.url.path.startswith("/api/"):
        if not current_user(request):
            return JSONResponse({"detail": "Not signed in"}, status_code=401)
        if request.method not in ("GET", "HEAD", "OPTIONS"):  # CSRF: state-changing calls must be same-origin
            origin = request.headers.get("origin")
            if origin and origin.split("://", 1)[-1] != request.headers.get("host"):
                return JSONResponse({"detail": "Cross-origin request blocked"}, status_code=403)
    return await call_next(request)


@router.get("/auth/config")
def config():
    return {"enabled": ENABLED, "client_id": CLIENT_ID}


@router.get("/auth/me")
def me(request: Request):
    if not ENABLED:
        return {"email": "local"}
    u = current_user(request)
    if not u:
        raise HTTPException(401, "Not signed in")
    return {"email": u}


class Login(BaseModel):
    credential: str


_fails: dict[str, list[float]] = {}


@router.post("/auth/login")
def login(body: Login, request: Request, response: Response):
    if not ENABLED:
        raise HTTPException(400, "Auth is not enabled")
    ip = request.client.host if request.client else "?"
    recent = [t for t in _fails.get(ip, []) if t > time.time() - 600]
    if len(recent) >= 10:  # brute-force / abuse throttle
        raise HTTPException(429, "Too many failed sign-ins. Try again in a few minutes.")
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as greq
        info = id_token.verify_oauth2_token(body.credential, greq.Request(), CLIENT_ID)
        email = (info.get("email") or "").lower()
        if not info.get("email_verified") or email not in ALLOWED:
            raise ValueError("not allowed")
    except Exception:
        _fails[ip] = recent + [time.time()]
        raise HTTPException(403, "This Google account is not authorised for this app.")
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, make_token(email), max_age=SESSION_HOURS * 3600, httponly=True,
                        secure=secure, samesite="lax", path="/")
    return {"email": email}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}
