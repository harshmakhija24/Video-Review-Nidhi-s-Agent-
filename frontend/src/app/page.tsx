"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Icon, Job, mss, Reel, Report, SheetStatus, stageLabel, Verdict } from "./lib";

type Filter = "all" | "pending" | "reviewed" | "flagged";

function JobProgress({ job }: { job: Job }) {
  const pct = Math.round((job.pct || 0) * 100);
  if (job.status === "waiting") {
    const at = job.retry_at ? new Date(job.retry_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon";
    return <span className="faint" style={{ fontSize: 12 }}>Partial notes ready · finishing at {at} (Groq vision quota)</span>;
  }
  const indet = job.status === "queued" || !["vision", "backtest"].some((s) => job.stage.startsWith(s));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className={`progress ${indet ? "indet" : ""}`}><div style={{ width: `${pct}%` }} /></div>
      <span className="faint" style={{ fontSize: 12 }}>{job.status === "queued" ? "Queued" : stageLabel(job.stage)}{!indet && ` · ${pct}%`}</span>
    </div>
  );
}

type Usage = { gemini: { configured: boolean; available: boolean; reels_today: number; daily_reels: number; calls_today: number; calls_cap: number; breaker_open_for_s: number; parked_models: Record<string, number> }; groq_parked: Record<string, number> };

function UsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  const [val, setVal] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api<Usage>("/api/usage").then((x) => { setU(x); setVal((v) => v || String(x.gemini.daily_reels)); }).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  if (!u) return null;
  const g = u.gemini;
  const used = g.daily_reels ? Math.min(100, (g.reels_today / g.daily_reels) * 100) : 100;
  const state = !g.configured ? "No Gemini key - using Groq" : g.breaker_open_for_s ? `Paused ${Math.ceil(g.breaker_open_for_s / 60)} min after errors - using Groq`
    : g.reels_today >= g.daily_reels ? "Daily limit reached - extra reels use Groq" : "Gemini active";
  const save = async () => {
    try { setU(await api<Usage>("/api/settings", { method: "POST", body: JSON.stringify({ daily_reels: Number(val) }) })); setMsg("Saved"); }
    catch (e) { setMsg((e as Error).message); }
    setTimeout(() => setMsg(""), 2500);
  };
  return (
    <section className="panel panel-pad" style={{ display: "grid", gap: 12, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="h2">Gemini daily limit</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{state} · {g.reels_today} of {g.daily_reels} reels today · {g.calls_today}/{g.calls_cap} API calls (safety cap)</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input id="input-daily-reels" type="number" min={0} max={1000} value={val} onChange={(e) => setVal(e.target.value)}
            style={{ width: 90, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line, #2a2a3a)", background: "transparent", color: "inherit" }} />
          <button id="btn-save-limit" className="btn" onClick={save} disabled={val === "" || Number(val) < 0 || Number(val) > 1000}>{msg || "Set reels/day"}</button>
        </div>
      </div>
      <div className={`progress`}><div style={{ width: `${used}%` }} /></div>
      <div className="faint" style={{ fontSize: 12 }}>0 pauses Gemini · max 1000 · enforced by the server, resets at midnight · re-reviewing an already-analysed reel is free</div>
    </section>
  );
}

export default function Desk() {
  const [reels, setReels] = useState<Reel[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [links, setLinks] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [toast, setToast] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3200); };

  const load = useCallback(async () => {
    try {
      const [r, j] = await Promise.all([api<{ reels: Reel[] }>("/api/reels"), api<{ jobs: Job[] }>("/api/jobs")]);
      setReels(r.reels); setJobs(j.jobs); setErr("");
    } catch (e) { setErr((e as Error).message); }
  }, []);

  const syncSheet = async () => {
    setSyncing(true);
    try {
      const res = await api<{ ok: boolean; count: number }>("/api/sync", { method: "POST" });
      flash(`Synced ${res.count} reels from Google Sheet & Drive!`);
      await load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const copyRowNotes = async (reelName: string, fid: string | null) => {
    if (!fid) return;
    try {
      const rep = await api<Report>(`/api/report/${fid}`);
      const text = rep.notes.map((n) => `${mss(n.t)} - ${n.note}`).join("\n");
      await navigator.clipboard.writeText(text);
      flash(`Copied ${rep.notes.length} notes for Reel ${reelName}!`);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, active ? 2500 : 15000);
    return () => clearInterval(t);
  }, [load, active]);

  const queue = async (body: object, msg: string) => {
    setBusy(true);
    try {
      const r = await api<{ queued: Job[] }>("/api/review", { method: "POST", body: JSON.stringify(body) });
      flash(r.queued.length ? `${msg} - ${r.queued.length} queued` : "Already in the queue");
      load();
    } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  };

  const stats = useMemo(() => {
    const rs = reels ?? [];
    return {
      total: rs.length,
      pending: rs.filter((r) => r.status === "Yet to review" && r.file_id).length,
      reviewed: rs.filter((r) => r.agent).length,
      flagged: rs.filter((r) => r.agent?.verdict === "Correction").length,
    };
  }, [reels]);

  const shown = (reels ?? []).filter((r) =>
    filter === "all" ? true : filter === "pending" ? r.status === "Yet to review" :
    filter === "reviewed" ? !!r.agent : r.agent?.verdict === "Correction");

  const sheetIds = new Set((reels ?? []).map((r) => r.file_id));
  const adhoc = jobs.filter((j) => j.kind === "review" && !sheetIds.has(j.file_id ?? null)).slice(0, 6);
  const sysJobs = jobs.filter((j) => j.kind !== "review" && (j.status === "running" || j.status === "queued"));

  return (
    <div className="page">
      <header>
        <div className="eyebrow">FDP · Final review</div>
        <h1 className="h1">The review desk that <em>thinks like Nidhi</em></h1>
        <p className="lede">
          Paste reel links or pull the &ldquo;Yet to review&rdquo; list from the sheet. The agent listens to the audio, reads every caption,
          watches the shots and transitions, and writes timestamped notes in Nidhi&rsquo;s voice - including the things she hasn&rsquo;t said yet but would.
        </p>
      </header>

      <section className="grid-stats">
        {[
          { k: "Reels in sheet", v: stats.total, c: "var(--accent)" },
          { k: "Waiting for review", v: stats.pending, c: "var(--warn)" },
          { k: "Reviewed by agent", v: stats.reviewed, c: "var(--info)" },
          { k: "Flagged for correction", v: stats.flagged, c: "var(--bad)" },
        ].map((s, i) => (
          <div key={s.k} className="panel stat" style={{ animation: `rise .6s var(--ease) ${i * 60}ms both` }}>
            <div className="eyebrow">{s.k}</div>
            <div className="stat-n">{reels ? s.v : "–"}</div>
            <div className="stat-bar" style={{ background: s.c }} />
          </div>
        ))}
      </section>

      <UsagePanel />

      <section className="panel panel-pad" style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div className="h2">Review new reels</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>Drive or YouTube links, one per line. Drive files must be shared &ldquo;anyone with the link&rdquo;.</div>
          </div>
          <button id="btn-review-pending" className="btn" disabled={busy || !stats.pending}
            onClick={() => queue({ pending: true }, "Pulled from sheet")}>
            <Icon.spark /> Review all &ldquo;Yet to review&rdquo; ({stats.pending})
          </button>
        </div>
        <textarea id="input-links" className="textarea" value={links} onChange={(e) => setLinks(e.target.value)}
          placeholder={"https://drive.google.com/file/d/…/view\nhttps://drive.google.com/file/d/…/view"} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button id="btn-review-links" className="btn btn-primary" disabled={busy || !links.trim()}
            onClick={() => { queue({ urls: [links] }, "Review started"); setLinks(""); }}>
            {busy ? <span className="spin" /> : <Icon.play />} Review {links.trim() ? links.trim().split(/[\s,]+/).filter(Boolean).length : ""} reel{links.trim().split(/[\s,]+/).filter(Boolean).length === 1 ? "" : "s"}
          </button>
        </div>
      </section>

      {(adhoc.length > 0 || sysJobs.length > 0) && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head"><div className="h2">Other jobs</div></div>
          <table className="table"><tbody>
            {[...sysJobs, ...adhoc].map((j) => (
              <tr key={j.id}>
                <td className="mono" style={{ fontSize: 12.5, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {j.kind === "review" ? (j.reel || j.url) : j.kind === "learn" ? "Re-learning rulebook from sheet" : "Backtest against Nidhi's past reviews"}
                </td>
                <td style={{ width: 200 }}>{j.status === "done" ? <Verdict v={j.verdict ?? "Done"} /> : j.status === "failed" ? <span className="chip c-bad" title={j.error}>Failed</span> : <JobProgress job={j} />}</td>
                <td style={{ width: 130, textAlign: "right" }}>{j.status === "done" && j.file_id && <Link className="btn btn-sm" href={`/report?id=${j.file_id}`}>Open report</Link>}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
      )}

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <div>
            <div className="h2">Review checklist</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Live from Nidhi&rsquo;s Google Sheet · videos matched from the Drive folder</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              id="btn-sync-sheet"
              className="btn btn-sm"
              disabled={syncing}
              onClick={syncSheet}
              title="Force fresh pull of reels and links from Google Sheet & Drive"
            >
              <span className={syncing ? "spin" : ""}><Icon.refresh /></span>
              {syncing ? "Syncing..." : "Sync Sheet"}
            </button>
            <div className="seg" role="tablist">
              {(["all", "pending", "reviewed", "flagged"] as Filter[]).map((f) => (
                <button key={f} id={`filter-${f}`} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                  {{ all: "All", pending: "Yet to review", reviewed: "Agent reviewed", flagged: "Flagged" }[f]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {err && <div className="banner c-bad" style={{ margin: 18 }}><Icon.alert className="shrink-0 w-4 h-4" /> {err}</div>}
        {!reels && !err && <div className="empty"><span className="spin" style={{ display: "inline-block" }} /></div>}
        {reels && shown.length === 0 && <div className="empty">Nothing here yet.</div>}
        {reels && shown.length > 0 && (
          <table className="table">
            <thead><tr><th>Reel</th><th>Editor</th><th>Nidhi</th><th>Revision Stage</th><th>Agent</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.reel}>
                  <td>
                    <div className="reel-name">{r.reel}</div>
                    {r.version && r.version > 1 && <span className="chip c-info" style={{ marginTop: 6, height: 20, fontSize: 10.5 }}>re-export v{String(r.version).padStart(2, "0")}</span>}
                    {!r.file_id && <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>no video in folder</div>}
                  </td>
                  <td className="muted">{r.editor}</td>
                  <td><SheetStatus s={r.status} /></td>
                  <td>
                    {r.revision ? (
                      <Link
                        href={`/notes-repo?reel=${r.reel}`}
                        title="Open in Notes & Revision Tracker"
                      >
                        <span
                          className={`chip ${
                            r.revision.status === "approved"
                              ? "c-ok"
                              : r.revision.status === "ready_for_review"
                              ? "c-info"
                              : "c-warn"
                          }`}
                          style={{ cursor: "pointer" }}
                        >
                          <i />
                          Review {r.revision.round}: {r.revision.nidhi_verified}/{r.revision.total} verified
                        </span>
                      </Link>
                    ) : r.agent ? (
                      <Link
                        href={`/notes-repo?reel=${r.reel}`}
                        className="chip c-info"
                        title="Open notes checklist"
                      >
                        <i /> Review 1
                      </Link>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td style={{ width: 180 }}>
                    {r.job ? <JobProgress job={r.job} /> : r.agent ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Verdict v={r.agent.verdict} /><span className="faint" style={{ fontSize: 12 }}>{r.agent.notes} notes</span>
                      </div>
                    ) : <span className="faint">—</span>}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {r.agent && r.file_id && (
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ marginRight: 4 }}
                        onClick={() => copyRowNotes(r.reel, r.file_id)}
                        title="Quick copy notes"
                      >
                        <Icon.copy />
                      </button>
                    )}
                    {r.agent && <Link id={`open-${r.reel}`} className="btn btn-sm" href={`/report?id=${r.file_id}`}>Open report</Link>}
                    {r.file_id && !r.job && (
                      <button id={`review-${r.reel}`} className={`btn btn-sm ${r.agent ? "btn-ghost" : ""}`} style={{ marginLeft: 6 }} disabled={busy}
                        title={r.agent ? "Rewrite the notes (cached analysis is reused)" : "Review this reel"}
                        onClick={() => queue({ reels: [r.reel], rerun: !!r.agent }, `${r.reel} queued`)}>
                        {r.agent ? <Icon.refresh /> : <><Icon.play /> Review</>}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
