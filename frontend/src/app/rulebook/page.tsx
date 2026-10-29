"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Icon, Job, Rule } from "../lib";

type Backtest = { ran?: string; results: { reel: string; status: string; her_note?: string; version?: number; agent_verdict?: string; matching_notes?: string[]; outcome: string }[] };

const OUTCOME: Record<string, string> = {
  caught: "c-ok", "fix confirmed": "c-ok", agrees: "c-ok",
  missed: "c-bad", "issue still present": "c-warn", "extra flags": "c-warn", "no video available": "",
};

const DEFAULT_RULES: Rule[] = [
  { id: "captions_missing", category: "captions", rule: "Every spoken line must have a caption on screen - no gaps, especially at the start.", examples: [{ reel: "04_04", editor: "Ashick", note: "Captions missing in 0.16second" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "grade_matches_delivery", category: "grading", rule: "B-roll / cutaway shots must be colour graded to match the professor's delivery footage.", examples: [{ reel: "04_06", editor: "Ashick", note: "Grading vs delivery not good on the scooter at 0.07" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "open_with_professor", category: "structure", rule: "Open on the professor's face; bring AI imagery in only after the professor is established.", examples: [{ reel: "04_13", editor: "Ashick", note: "Starting with ai image does look good lets start with prof face and then bring the ai componenet" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "visuals_match_speech", category: "relevance", rule: "Visuals on screen must illustrate exactly what the speaker is saying at that moment.", examples: [{ reel: "05_01", editor: "Karthik", note: "0,37 sec to 0.46 sec visuals not matching what the speaker says" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "too_many_broll", category: "pacing", rule: "Too many b-rolls / too much happening at once is overwhelming - keep the professor on screen and use cutaways sparingly.", examples: [{ reel: "-", editor: "-", note: "too many b rolls it becomes overwhelming" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "jarring_visuals", category: "relevance", rule: "No sudden, alarming or negative imagery in cutaways (e.g. a barking dog with red bared teeth popping up on the word 'bark').", examples: [{ reel: "-", editor: "-", note: "a dog bark was the word and a red sudden barking teeth came up which feels weird and also negative" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "no_negative_graphs", category: "relevance", rule: "Never use graphs or arrows going down / declining charts in the b-roll animations - at any cost.", examples: [{ reel: "-", editor: "-", note: "graphs going down shouldn't be taken in the b roll animations at any cost" }], basis: "observed", status: "active", confidence: 1.0 },
  { id: "no_missing_captions_at_end", category: "captions", rule: "Every spoken line, including the final sentence, must have a caption that stays on screen until the speech ends.", because: "She flags any caption gaps, e.g., \"Captions missing in 0.16second,\" so she will also notice missing captions at the close.", confidence: 0.78, basis: "predicted", status: "active", examples: [] },
  { id: "consistent_caption_style", category: "captions", rule: "All captions must use the same font, size, colour and background throughout the reel.", because: "Her focus on caption presence suggests she will also enforce visual uniformity of captions.", confidence: 0.71, basis: "predicted", status: "active", examples: [] },
  { id: "grade_consistency_across_broll", category: "grading", rule: "Colour grading of every B‑roll clip must match the lighting and tone of the professor’s primary footage throughout the whole reel.", because: "She already rejected a single mismatch (“Grading vs delivery not good on the scooter at 0.07”), indicating a broader expectation of consistent grading.", confidence: 0.82, basis: "predicted", status: "active", examples: [] },
  { id: "no_jarring_color_shifts", category: "grading", rule: "Avoid sudden colour shifts between cuts; transitions should feel seamless.", because: "Her comment on grading implies she notices any visual discontinuity that distracts from the delivery.", confidence: 0.65, basis: "predicted", status: "active", examples: [] },
  { id: "professor_first_5_seconds", category: "structure", rule: "The professor’s face must remain on screen for at least the first five seconds before any graphics or AI images appear.", because: "She stresses opening on the professor’s face before AI elements.", confidence: 0.74, basis: "predicted", status: "active", examples: [] },
  { id: "clear_story_arc", category: "structure", rule: "Each reel should have a brief intro, a middle that supports the main point, and a concise wrap‑up that returns to the professor.", because: "Her structural feedback (“Open on the professor’s face…”) shows she values a logical flow.", confidence: 0.62, basis: "predicted", status: "active", examples: [] },
  { id: "visuals_directly_echo_speech", category: "relevance", rule: "Every visual element (AI image, slide, B‑roll) must illustrate exactly what the professor is saying at that moment.", because: "She already flagged mismatched visuals (“visuals not matching what the speaker says”).", confidence: 0.85, basis: "predicted", status: "active", examples: [] },
  { id: "avoid_generic_stock_footage", category: "relevance", rule: "Do not use generic stock clips that do not have a clear connection to the spoken content.", because: "Her emphasis on relevance suggests she will reject unrelated filler footage.", confidence: 0.58, basis: "predicted", status: "active", examples: [] },
  { id: "smooth_animated_transitions", category: "animation_transitions", rule: "Animated slide graphics and title cards must fade or slide in gently; abrupt pops are not acceptable.", because: "She approves hard cuts but expects professionalism, so jarring animation would stand out.", confidence: 0.66, basis: "predicted", status: "active", examples: [] },
  { id: "audio_level_consistency", category: "audio", rule: "The professor’s voice should remain at a consistent volume throughout; no sudden drops or spikes.", because: "While she hasn’t mentioned audio yet, her attention to detail in visual grading implies she will also notice audible inconsistencies.", confidence: 0.55, basis: "predicted", status: "active", examples: [] },
];

export default function Rulebook() {
  const [rules, setRules] = useState<Rule[]>(DEFAULT_RULES);
  const [updated, setUpdated] = useState<string | null>(null);
  const [bt, setBt] = useState<Backtest>({ results: [] });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const [rb, b, j] = await Promise.all([
      api<{ rules: Rule[]; updated: string | null }>("/api/rulebook"),
      api<Backtest>("/api/backtest").catch(() => ({ results: [] } as Backtest)),
      api<{ jobs: Job[] }>("/api/jobs").catch(() => ({ jobs: [] })),
    ]);
    if (rb.rules?.length) setRules(rb.rules);
    setUpdated(rb.updated); setBt(b); setJobs(j.jobs);
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
    setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, status } : x)));  // optimistic
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
