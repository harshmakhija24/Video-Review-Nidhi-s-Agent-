"""Email one-time-code login + allowlist. Fail-closed: the server refuses to listen publicly without it.

Flow: user enters email -> if it is on ALLOWED_EMAILS we mail a 6-digit code (valid 10 min, 5 tries, single use)
-> POST /auth/verify -> signed, HttpOnly, SameSite session cookie. Every /api/* call is checked by `middleware`.
The response to /auth/request is identical for allowed and unknown emails, so the allowlist can't be probed.
"""
import os
import ssl
import time
import hmac
import base64
import hashlib
import secrets
import smtplib
import threading
from email.message import EmailMessage
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

ALLOWED = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "12"))
CODE_TTL = 600
COOKIE = "rr_session"
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "") or SMTP_USER
BREVO_KEY = os.environ.get("BREVO_API_KEY", "")  # HTTPS email API (works where SMTP ports are blocked, e.g. Render free)
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")  # simple mode: email on the allowlist + this shared password
_secret = os.environ.get("SESSION_SECRET", "") or secrets.token_urlsafe(48)  # unset: sessions reset on restart
SECRET = _secret.encode()
ENABLED = bool(ALLOWED)

router = APIRouter()
_lock = threading.Lock()
_codes: dict[str, dict] = {}        # email -> {h, exp, tries, sent}
_ip_hits: dict[str, list[float]] = {}


def check_startup(host: str):
    """Never expose the API publicly without auth, nor with auth but no way to deliver codes."""
    local = host in ("127.0.0.1", "localhost", "::1")
    if not ENABLED and not local:
        raise SystemExit("Refusing to start: HOST is public but ALLOWED_EMAILS is not set (auth disabled).")
    if ENABLED and APP_PASSWORD and len(APP_PASSWORD) < 8:
        raise SystemExit("Refusing to start: APP_PASSWORD must be at least 8 characters.")
    if ENABLED and not local and not APP_PASSWORD and not (BREVO_KEY and SMTP_FROM) and not (SMTP_HOST and SMTP_USER and SMTP_PASS):
        raise SystemExit("Refusing to start: public HOST needs APP_PASSWORD (or BREVO_API_KEY + SMTP_FROM) to authenticate users.")


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


def _hash(email: str, code: str) -> str:
    return _sign(f"{email}:{code}")


def _send_brevo(email: str, code: str):
    import json
    import urllib.request
    body = json.dumps({"sender": {"email": SMTP_FROM, "name": "Reel Reviewer"}, "to": [{"email": email}],
                       "subject": f"Reel Reviewer sign-in code: {code}",
                       "textContent": f"Your sign-in code is {code}\n\nIt expires in {CODE_TTL // 60} minutes. "
                                      "If you didn't request it, ignore this email."}).encode()
    req = urllib.request.Request("https://api.brevo.com/v3/smtp/email", data=body, method="POST",
                                 headers={"api-key": BREVO_KEY, "content-type": "application/json", "accept": "application/json"})
    urllib.request.urlopen(req, timeout=20).read()


def _send(email: str, code: str):
    if BREVO_KEY and SMTP_FROM:
        try:
            _send_brevo(email, code)
            print(f"[auth] code emailed via Brevo to {email}", flush=True)
        except Exception as e:
            print(f"[auth] Brevo send failed: {type(e).__name__} {getattr(e, 'read', lambda: b'')()[:200]}", flush=True)
        return
    if not (SMTP_HOST and SMTP_USER and SMTP_PASS):
        print(f"[auth] DEV MODE (no SMTP configured) - login code for {email}: {code}", flush=True)
        return
    try:
        m = EmailMessage()
        m["Subject"] = f"Reel Reviewer sign-in code: {code}"
        m["From"], m["To"] = SMTP_FROM, email
        m.set_content(f"Your sign-in code is {code}\n\nIt expires in {CODE_TTL // 60} minutes. "
                      "If you didn't request it, ignore this email.")
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(m)
    except Exception as e:
        print(f"[auth] email send failed: {type(e).__name__}", flush=True)


def _throttle(ip: str, limit: int, window: int):
    now = time.time()
    hits = [t for t in _ip_hits.get(ip, []) if t > now - window]
    if len(hits) >= limit:
        raise HTTPException(429, "Too many attempts. Try again in a few minutes.")
    _ip_hits[ip] = hits + [now]


@router.get("/auth/config")
def config():
    return {"enabled": ENABLED, "mode": "password" if APP_PASSWORD else "code"}


class PasswordLogin(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def password_login(body: PasswordLogin, request: Request, response: Response):
    if not (ENABLED and APP_PASSWORD):
        raise HTTPException(400, "Password login is not enabled")
    _throttle("pw:" + (request.client.host if request.client else "?"), 10, 600)  # brute-force guard
    email = body.email.strip().lower()
    ok = hmac.compare_digest(body.password.encode(), APP_PASSWORD.encode())
    if not (ok and email in ALLOWED):
        time.sleep(1)
        raise HTTPException(403, "Wrong email or password.")
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, make_token(email), max_age=SESSION_HOURS * 3600, httponly=True,
                        secure=secure, samesite="lax", path="/")
    return {"email": email}


@router.get("/auth/me")
def me(request: Request):
    if not ENABLED:
        return {"email": "local"}
    u = current_user(request)
    if not u:
        raise HTTPException(401, "Not signed in")
    return {"email": u}


class CodeRequest(BaseModel):
    email: str


class CodeVerify(BaseModel):
    email: str
    code: str


@router.post("/auth/request")
def request_code(body: CodeRequest, request: Request):
    if not ENABLED or APP_PASSWORD:
        raise HTTPException(400, "Code login is not enabled")
    _throttle("req:" + (request.client.host if request.client else "?"), 10, 3600)
    email = body.email.strip().lower()[:254]
    if email in ALLOWED:
        with _lock:
            old = _codes.get(email)
            if not old or time.time() - old["sent"] > 60:  # max one code per minute per email
                code = f"{secrets.randbelow(10**6):06d}"
                _codes[email] = {"h": _hash(email, code), "exp": time.time() + CODE_TTL, "tries": 0, "sent": time.time()}
                threading.Thread(target=_send, args=(email, code), daemon=True).start()
    return {"ok": True}  # same answer whether or not the email is allowed


@router.post("/auth/verify")
def verify_code(body: CodeVerify, request: Request, response: Response):
    if not ENABLED or APP_PASSWORD:
        raise HTTPException(400, "Code login is not enabled")
    _throttle("ver:" + (request.client.host if request.client else "?"), 20, 600)
    email, code = body.email.strip().lower(), body.code.strip()
    with _lock:
        rec = _codes.get(email)
        ok = False
        if rec and rec["exp"] > time.time() and rec["tries"] < 5:
            rec["tries"] += 1
            ok = hmac.compare_digest(rec["h"], _hash(email, code))
            if ok:
                del _codes[email]  # single use
    if not ok or email not in ALLOWED:
        raise HTTPException(403, "Invalid or expired code.")
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, make_token(email), max_age=SESSION_HOURS * 3600, httponly=True,
                        secure=secure, samesite="lax", path="/")
    return {"email": email}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.delete_cookie(COOKIE, path="/", httponly=True, secure=secure, samesite="lax")
    return {"ok": True}
