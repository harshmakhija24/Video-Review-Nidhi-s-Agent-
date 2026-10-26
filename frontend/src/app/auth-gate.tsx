"use client";

import { useEffect, useRef, useState } from "react";
import { API } from "./lib";

type G = { accounts: { id: { initialize: (o: object) => void; renderButton: (el: HTMLElement, o: object) => void } } };
declare global { interface Window { google?: G } }

/** Blocks the app until the user has signed in with an allow-listed Google account. */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "out" | "in">("loading");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const btn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch(`${API}/auth/config`, { credentials: "include" })).json();
        if (!cfg.enabled) { setState("in"); return; }
        const me = await fetch(`${API}/auth/me`, { credentials: "include" });
        if (me.ok) { setEmail((await me.json()).email); setState("in"); return; }
        setState("out");
        const s = document.createElement("script");
        s.src = "https://accounts.google.com/gsi/client";
        s.async = true;
        s.onload = () => {
          window.google!.accounts.id.initialize({
            client_id: cfg.client_id,
            callback: async (resp: { credential: string }) => {
              const r = await fetch(`${API}/auth/login`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ credential: resp.credential }),
              });
              if (r.ok) { setEmail((await r.json()).email); setState("in"); }
              else setErr((await r.json().catch(() => ({}))).detail ?? "Sign-in failed");
            },
          });
          if (btn.current) window.google!.accounts.id.renderButton(btn.current, { theme: "filled_black", size: "large", shape: "pill" });
        };
        document.head.appendChild(s);
      } catch { setErr("Cannot reach the server."); setState("out"); }
    })();
  }, []);

  if (state === "loading") return null;
  if (state === "out") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", display: "grid", gap: 16, justifyItems: "center" }}>
          <div className="brand-mark">N</div>
          <h1 style={{ fontSize: 22 }}>Reel Reviewer</h1>
          <div className="faint">Sign in with an authorised Google account</div>
          <div ref={btn} id="google-signin" />
          {err && <div role="alert" style={{ color: "#f87171" }}>{err}</div>}
        </div>
      </div>
    );
  }
  return (
    <>
      {children}
      {email && email !== "local" && (
        <button
          id="signout"
          className="faint"
          style={{ position: "fixed", bottom: 12, right: 16, background: "none", border: 0, cursor: "pointer" }}
          onClick={async () => { await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" }); location.reload(); }}
        >
          {email} · Sign out
        </button>
      )}
    </>
  );
}
