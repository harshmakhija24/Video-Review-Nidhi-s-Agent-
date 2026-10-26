"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api, API, BASIS_CLASS, Icon, mss, Note, Report, SEV_COLOR, Verdict } from "../lib";

function NoteRow({ n, i, playing, onSeek }: { n: Note; i: number; playing: boolean; onSeek: (t: number) => void }) {
  return (
    <div className={`note ${playing ? "playing" : ""}`} style={{ animationDelay: `${i * 40}ms` }} onClick={() => onSeek(n.t)}
      role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSeek(n.t)} id={`note-${i}`}>
      <div className="note-time">{mss(n.t)}{n.end - n.t >= 1.5 && <div className="faint" style={{ fontSize: 11 }}>→ {mss(n.end)}</div>}</div>
      <div>
        <div className="note-text"><span className="sev" style={{ background: SEV_COLOR[n.severity] ?? "var(--muted)" }} />{n.note}</div>
        <div className="note-meta">
          <span className="chip">{n.category}</span>
          <span className={`chip ${BASIS_CLASS[n.basis] ?? ""}`}
            title={n.basis === "predicted" ? "Not something Nidhi has written before - predicted from her patterns" : n.basis === "observed" ? "A rule Nidhi has enforced in the sheet" : "Technical check"}>
            {n.basis === "observed" ? "her rule" : n.basis}
          </span>
          {n.evidence && <span className="faint" style={{ fontSize: 12, alignSelf: "center" }}>{n.evidence}</span>}
        </div>
      </div>
    </div>
  );
}

function ReportView() {
  const id = useSearchParams().get("id") ?? "";
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!id) return;
    api<Report>(`/api/report/${id}`).then(setRep).catch((e) => setErr(e.message));
  }, [id]);

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, t - 0.3);
    v.play().catch(() => {});
  };

  const copy = async () => {
    if (!rep) return;
    const text = rep.notes.map((n) => `${mss(n.t)} - ${n.note}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };

  if (err) return <div className="page"><div className="banner c-bad"><Icon.alert className="w-4 h-4 shrink-0" />{err}</div></div>;
  if (!rep) return <div className="page"><div className="empty"><span className="spin" style={{ display: "inline-block" }} /></div></div>;

  const ok = rep.verdict === "Approved";
  const playingIdx = rep.notes.findIndex((n) => now >= n.t - 0.5 && now <= Math.max(n.end, n.t + 2.5));
  const counts = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  rep.notes.forEach((n) => (counts[n.severity] = (counts[n.severity] ?? 0) + 1));

  return (
    <div className="page">
      <Link href="/" className="btn btn-sm btn-ghost" style={{ marginLeft: -12 }}><Icon.back /> Review desk</Link>
      <header style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Agent review · {rep.created}</div>
          <h1 className="h1" style={{ marginBottom: 6 }}>Reel <em>{rep.reel ?? rep.file_id.slice(0, 8)}</em></h1>
          <div className="muted">
            {rep.editor && <>Editor {rep.editor} · </>}{rep.media.duration.toFixed(0)}s · {rep.media.width}×{rep.media.height} · {rep.media.fps}fps · {rep.media.cuts.length} cuts
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a className="btn" href={rep.url} target="_blank" rel="noreferrer" id="btn-open-drive"><Icon.link /> Open in Drive</a>
          <button className="btn btn-primary" onClick={copy} id="btn-copy-notes" disabled={!rep.notes.length}>
            {copied ? <Icon.check /> : <Icon.copy />} {copied ? "Copied" : "Copy notes for sheet"}
          </button>
        </div>
      </header>

      {rep.skipped.length > 0 && (
        <div className="banner c-warn" style={{ marginTop: 20 }}>
          <Icon.alert className="w-4 h-4 shrink-0" />
          <div><strong>Partial review.</strong> Some checks couldn&rsquo;t run yet: {rep.skipped.join("; ")}.{" "}
            {rep.retry_at ? `It finishes itself around ${new Date(rep.retry_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, when Groq's daily vision quota frees up.` : "Re-run to retry."}</div>
        </div>
      )}

      <div className="report-grid">
        <div className="player-wrap">
          <video ref={video} className="player" src={`${API}/api/video/${rep.file_id}`} controls playsInline preload="metadata"
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} id="player" />
          <div className="mono faint" style={{ fontSize: 12, textAlign: "center", marginTop: 10 }}>{mss(now)} · click a note to jump</div>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          <section className="panel verdict">
            <div className="verdict-icon" style={{ background: ok ? "rgba(74,222,155,.12)" : "rgba(255,107,129,.12)", color: ok ? "var(--ok)" : "var(--bad)" }}>
              {ok ? <Icon.check /> : <Icon.alert />}
            </div>
            <div style={{ flex: 1 }}>
              <div className="verdict-title">{ok ? "Approved" : "Needs correction"}</div>
              <div className="muted" style={{ marginTop: 6, lineHeight: 1.5 }}>{rep.summary}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {counts.high > 0 && <span className="chip c-bad">{counts.high} high</span>}
              {counts.medium > 0 && <span className="chip c-warn">{counts.medium} medium</span>}
              {counts.low > 0 && <span className="chip c-info">{counts.low} low</span>}
            </div>
          </section>

          <section className="panel" style={{ overflow: "hidden" }}>
            <div className="panel-head">
              <div className="h2">Notes for the editor</div>
              <Verdict v={rep.verdict} />
            </div>
            {rep.notes.length === 0 ? <div className="empty">No issues found - this one looks good to go.</div> :
              rep.notes.map((n, i) => <NoteRow key={i} n={n} i={i} playing={i === playingIdx} onSeek={seek} />)}
          </section>

          <section className="panel panel-pad">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="h2">Frames the agent watched</div>
              <span className="faint" style={{ fontSize: 12.5 }}>{rep.frames.length} frames · red = speech but no caption read</span>
            </div>
            <div className="filmstrip">
              {rep.frames.map((f) => (
                <div key={f.t} className={`frame ${!f.caption ? "nocap" : ""}`} onClick={() => seek(f.t)} title={`${f.shot ?? ""} · ${f.caption ?? "no caption"}`}>
                  <img src={`${API}/api/frame/${rep.file_id}/${f.file}`} alt={`Frame at ${mss(f.t)}`} loading="lazy" />
                  <span>{mss(f.t)}</span>
                </div>
              ))}
            </div>
          </section>

          {rep.dropped.length > 0 && (
            <details className="panel fold">
              <summary>Dismissed by the agent ({rep.dropped.length}) <Icon.down /></summary>
              <div style={{ borderTop: "1px solid var(--line)" }}>
                {rep.dropped.map((n, i) => <NoteRow key={i} n={n} i={i} playing={false} onSeek={seek} />)}
              </div>
            </details>
          )}

          <details className="panel fold">
            <summary>Transcript <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>{rep.transcript_source}</span> <Icon.down /></summary>
            <p style={{ padding: "0 22px 22px", lineHeight: 1.7 }} className="muted">{rep.transcript || "No transcript."}</p>
          </details>
        </div>
      </div>
    </div>
  );
}

export default function ReportPage() {
  return (
    <Suspense fallback={<div className="page"><div className="empty"><span className="spin" style={{ display: "inline-block" }} /></div></div>}>
      <ReportView />
    </Suspense>
  );
}
