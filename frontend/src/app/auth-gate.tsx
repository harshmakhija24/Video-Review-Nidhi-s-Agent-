"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { API } from "./lib";

const post = (path: string, body: object) =>
  fetch(`${API}${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const AuthCtx = createContext<{ email: string; signOut: () => void }>({ email: "", signOut: () => {} });

export function UserStatus() {
  const { email, signOut } = useContext(AuthCtx);
  const displayEmail = email && email !== "local" ? email : "Active session";
  return (
    <div
      style={{
        marginBottom: 12,
        padding: "12px",
        borderRadius: 14,
        background: "rgba(255, 255, 255, 0.04)",
        border: "1px solid var(--line-2)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "rgba(182, 156, 255, 0.18)",
            color: "var(--accent)",
            display: "grid",
            placeItems: "center",
            fontWeight: 700,
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {displayEmail[0]?.toUpperCase()}
        </div>
        <div style={{ overflow: "hidden" }}>
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", fontWeight: 600 }}>
            Signed in as
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text)",
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={displayEmail}
          >
            {displayEmail}
          </div>
        </div>
      </div>
      <button
        id="signout"
        type="button"
        onClick={signOut}
        className="btn btn-sm"
        style={{
          width: "100%",
          justifyContent: "center",
          background: "rgba(255, 107, 129, 0.14)",
          borderColor: "rgba(255, 107, 129, 0.4)",
          color: "#ff8fa3",
          fontWeight: 600,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        Sign out
      </button>
    </div>
  );
}

/** Blocks the app until the user signs in with an emailed one-time code (allow-listed emails only). */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "email" | "code" | "in">("loading");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [mode, setMode] = useState<"code" | "password">("code");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch(`${API}/auth/config`, { credentials: "include" })).json();
        if (!cfg.enabled) { setState("in"); return; }
        setMode(cfg.mode === "password" ? "password" : "code");
        const me = await fetch(`${API}/auth/me`, { credentials: "include" });
        if (me.ok) { setEmail((await me.json()).email); setState("in"); return; }
        setState("email");
      } catch { setErr("Cannot reach the server."); setState("email"); }
    })();
  }, []);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    if (mode === "password") {
      const r = await post("/auth/login", { email, password: pw });
      setBusy(false);
      if (r.ok) { setEmail(email.trim().toLowerCase()); setState("in"); }
      else setErr((await r.json().catch(() => ({}))).detail ?? "Sign-in failed.");
      return;
    }
    const r = await post("/auth/request", { email });
    setBusy(false);
    if (r.ok) setState("code"); else setErr((await r.json().catch(() => ({}))).detail ?? "Could not send a code.");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const r = await post("/auth/verify", { email, code });
    setBusy(false);
    if (r.ok) { setEmail(email.trim().toLowerCase()); setState("in"); }
    else setErr((await r.json().catch(() => ({}))).detail ?? "Sign-in failed.");
  }

  async function signOut() {
    await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
    setPw("");
    setCode("");
    setState("email");
  }

  if (state === "loading") return null;
  if (state === "email" || state === "code") {
    const field = { padding: "10px 14px", borderRadius: 10, border: "1px solid #444", background: "transparent", color: "inherit", width: 280 };
    const go = { padding: "10px 20px", borderRadius: 999, border: 0, cursor: "pointer", fontWeight: 600 };
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <form onSubmit={state === "email" ? sendCode : verify} style={{ textAlign: "center", display: "grid", gap: 14, justifyItems: "center" }}>
          <div className="brand-mark">N</div>
          <h1 style={{ fontSize: 22 }}>Reel Reviewer</h1>
          {state === "email" ? (
            <>
              <div className="faint">{mode === "password" ? "Enter your authorised email and the access password" : "Enter your authorised email to get a sign-in code"}</div>
              <input id="login-email" type="email" required autoFocus placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={field} />
              {mode === "password" && <input id="login-password" type="password" required placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} style={field} />}
              <button id="login-send" style={go} disabled={busy}>{busy ? "Please wait…" : mode === "password" ? "Sign in" : "Send code"}</button>
            </>
          ) : (
            <>
              <div className="faint">If {email} is authorised, a 6-digit code is on its way (valid 10 minutes).</div>
              <input id="login-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoFocus placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ ...field, textAlign: "center", letterSpacing: 6 }} />
              <button id="login-verify" style={go} disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
              <button type="button" className="faint" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => { setState("email"); setCode(""); setErr(""); }}>Use a different email</button>
            </>
          )}
          {err && <div role="alert" style={{ color: "#f87171" }}>{err}</div>}
        </form>
      </div>
    );
  }
  return <AuthCtx.Provider value={{ email, signOut }}>{children}</AuthCtx.Provider>;
}
