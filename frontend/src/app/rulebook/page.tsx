"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Icon, Job, Rule } from "../lib";

type Backtest = { ran?: string; results: { reel: string; status: string; her_note?: string; version?: number; agent_verdict?: string; matching_notes?: string[]; outcome: string }[] };

const OUTCOME: Record<string, string> = {
  caught: "c-ok", "fix confirmed": "c-ok", agrees: "c-ok",
  missed: "c-bad", "issue still present": "c-warn", "extra flags": "c-warn", "no video available": "",
};

export default function Rulebook() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [bt, setBt] = useState<Backtest>({ results: [] });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const [rb, b, j] = await Promise.all([
      api<{ rules: Rule[]; updated: string | null }>("/api/rulebook"),
      api<Backtest>("/api/backtest"),
      api<{ jobs: Job[] }>("/api/jobs"),
    ]);
    setRules(rb.rules); setUpdated(rb.updated); setBt(b); setJobs(j.jobs);
  }, []);

  const running = (k: string) => jobs.find((j) => j.kind === k && (j.status === "running" || j.status === "queued"));
  const busy = !!running("learn") || !!running("backtest");
  useEffect(() => { load().catch(() => {}); }, [load]);
  useEffect(() => {
    const t = setInterval(() => load().catch(() => {}), busy ? 3000 : 20000);
    return () => clearInterval(t);
  }, [load, busy]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3000); };

  const decide = async (r: Rule) => {
    const status = r.status === "rejected" ? "active" : "rejected";
    setRules((rs) => rs?.map((x) => (x.id === r.id ? { ...x, status } : x)) ?? null);  // optimistic
    try {
      const rb = await api<{ rules: Rule[] }>(`/api/rulebook/${r.id}`, { method: "POST", body: JSON.stringify({ status }) });
      setRules(rb.rules);
    } catch (e) { flash((e as Error).message); load(); }
  };

  const start = async (path: string, msg: string) => {
    try { await api(path, { method: "POST" }); flash(msg); load(); } catch (e) { flash((e as Error).message); }
  };

  const observed = rules?.filter((r) => r.basis === "observed") ?? [];
  const predicted = (rules?.filter((r) => r.basis === "predicted") ?? []).sort((a, b) => b.confidence - a.confidence);
  const scored = bt.results.filter((r) => r.outcome !== "no video available");
  const good = scored.filter((r) => ["caught", "fix confirmed", "agrees"].includes(r.outcome)).length;
  const learnJob = running("learn"), btJob = running("backtest");

  return (
    <div className="page">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">What the agent has learned</div>
          <h1 className="h1">Nidhi&rsquo;s <em>rulebook</em></h1>
          <p className="lede">
            Rules come from her comments in the review sheet. The agent extends them into <strong>predicted rules</strong> - things she
            hasn&rsquo;t written yet but her standards imply. Switch off any prediction that&rsquo;s wrong; it stops being applied immediately.
          </p>
        </div>
        <button id="btn-learn" className="btn btn-primary" disabled={!!learnJob} onClick={() => start("/api/rulebook/learn", "Re-learning from the sheet…")}>
          {learnJob ? <span className="spin" /> : <Icon.refresh />} {learnJob ? "Learning…" : "Re-learn from sheet"}
        </button>
      </header>

      <section style={{ marginTop: 30 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
          <div className="h2">Her rules</div>
          <span className="faint" style={{ fontSize: 12.5 }}>{observed.length} learned from the sheet{updated && ` · updated ${updated}`}</span>
        </div>
        <div className="rules">
          {observed.map((r, i) => (
            <article key={r.id} className="panel rule" style={{ animation: `rise .5s var(--ease) ${i * 50}ms both` }}>
              <div style={{ display: "flex", gap: 8 }}><span className="chip c-acc">{r.category}</span><span className="chip mono">{r.id}</span></div>
              <div className="rule-text">{r.rule}</div>
              {r.examples.map((e, j) => (
                <div key={j}>
                  <div className="quote">&ldquo;{e.note}&rdquo;</div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 6, paddingLeft: 16 }}>Reel {e.reel} · {e.editor}</div>
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 36 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
          <div className="h2">Predicted rules</div>
          <span className="faint" style={{ fontSize: 12.5 }}>{predicted.filter((r) => r.status !== "rejected").length} active of {predicted.length}</span>
        </div>
        {predicted.length === 0 ? (
          <div className="panel empty">No predictions yet - click &ldquo;Re-learn from sheet&rdquo; to generate them.</div>
        ) : (
          <div className="rules">
            {predicted.map((r, i) => (
              <article key={r.id} className={`panel rule ${r.status === "rejected" ? "rejected" : ""}`} style={{ animation: `rise .5s var(--ease) ${i * 35}ms both` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8 }}><span className="chip c-warn">{r.category}</span><span className="chip mono">{r.id}</span></div>
                  <button id={`toggle-${r.id}`} className={`btn btn-sm ${r.status === "rejected" ? "" : "btn-ghost"}`} onClick={() => decide(r)}
                    title={r.status === "rejected" ? "Start applying this rule again" : "Nidhi wouldn't flag this - stop applying it"}>
                    {r.status === "rejected" ? <><Icon.check /> Restore</> : <><Icon.x /> Not her</>}
                  </button>
                </div>
                <div className="rule-text">{r.rule}</div>
                {r.because && <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{r.because}</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="conf" style={{ flex: 1 }}><div style={{ width: `${Math.round(r.confidence * 100)}%` }} /></div>
                  <span className="mono faint" style={{ fontSize: 12 }}>{Math.round(r.confidence * 100)}%</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 36 }}>
        <div className="panel-head">
          <div>
            <div className="h2">Backtest against her past reviews</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              {bt.ran ? <>Last run {bt.ran} · {good}/{scored.length} agree with Nidhi</> : "Runs the agent on every reel she has already judged."}
            </div>
          </div>
          <button id="btn-backtest" className="btn" disabled={!!btJob} onClick={() => start("/api/backtest", "Backtest queued")}>
            {btJob ? <><span className="spin" /> {btJob.stage}</> : <><Icon.play /> Run backtest</>}
          </button>
        </div>
        {bt.results.length === 0 ? <div className="empty">No backtest yet.</div> : (
          <table className="table">
            <thead><tr><th>Reel</th><th>Nidhi said</th><th>Agent</th><th>Outcome</th></tr></thead>
            <tbody>
              {bt.results.map((r) => (
                <tr key={r.reel}>
                  <td className="reel-name">{r.reel}{r.version && r.version > 1 ? <span className="faint mono" style={{ fontSize: 11 }}> v{r.version}</span> : null}</td>
                  <td className="note-cell">{r.status}{r.her_note ? ` - "${r.her_note}"` : ""}</td>
                  <td className="note-cell">{r.agent_verdict ?? "—"}{r.matching_notes?.length ? ` - "${r.matching_notes[0]}"` : ""}</td>
                  <td><span className={`chip ${OUTCOME[r.outcome] ?? ""}`}>{r.outcome}</span></td>
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
