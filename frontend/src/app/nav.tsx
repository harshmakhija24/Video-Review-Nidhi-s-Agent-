"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, Icon, Job, stageLabel } from "./lib";

const LINKS = [
  { href: "/", label: "Review Desk", icon: Icon.desk, match: (p: string) => p === "/" || p.startsWith("/report") },
  { href: "/notes-repo", label: "Notes & Revisions", icon: Icon.checklist, match: (p: string) => p.startsWith("/notes-repo") },
  { href: "/rulebook", label: "Nidhi's Rulebook", icon: Icon.book, match: (p: string) => p.startsWith("/rulebook") },
];

function ActiveJobWidget() {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    let mounted = true;
    const fetchJobs = () => {
      api<{ jobs: Job[] }>("/api/jobs")
        .then((r) => {
          if (mounted) setJobs(r.jobs || []);
        })
        .catch(() => {});
    };
    fetchJobs();
    const interval = setInterval(fetchJobs, 2500);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const activeList = jobs
    .filter((j) => j.status === "running" || j.status === "queued")
    .sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || (a.created || 0) - (b.created || 0));
  if (!activeList.length) return null;

  let qPos = 0;

  return (
    <div
      style={{
        marginTop: 18,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(182, 156, 255, 0.08)",
        border: "1px solid rgba(182, 156, 255, 0.22)",
        fontSize: 12,
        display: "grid",
        gap: 10,
        maxHeight: 240,
        overflowY: "auto",
      }}
    >
      {activeList.length > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", fontWeight: 600 }}>
          <span>Active queue</span>
          <span className="mono">{activeList.length} jobs</span>
        </div>
      )}
      {activeList.map((job, idx) => {
        const isQueued = job.status === "queued";
        if (isQueued) qPos += 1;
        const pct = Math.round((job.pct || 0) * 100);
        const indet = isQueued || !["vision", "backtest"].some((s) => job.stage.startsWith(s));
        const label = job.kind === "review" ? `Reviewing ${job.reel || "Reel"}` : job.kind === "learn" ? "Re-learning rules" : "Running backtest";
        return (
          <div key={job.id} style={idx > 0 ? { paddingTop: 9, borderTop: "1px solid rgba(255, 255, 255, 0.07)" } : undefined}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: isQueued ? "var(--text)" : "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: isQueued ? "var(--warn)" : "var(--accent)",
                    display: "inline-block",
                    boxShadow: isQueued ? "none" : "0 0 8px var(--accent)",
                  }}
                />
                {label}
              </span>
              {!indet ? (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}>{pct}%</span>
              ) : isQueued ? (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--warn)" }}>#{qPos}</span>
              ) : null}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {isQueued ? "Queued next in background…" : stageLabel(job.stage)}
            </div>
            <div className={`progress ${indet ? "indet" : ""}`} style={{ width: "100%", height: 3 }}>
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Nav() {
  const path = usePathname() || "/";
  return (
    <nav className="nav">
      {LINKS.map(({ href, label, icon: I, match }) => (
        <Link key={href} href={href} id={`nav-${href === "/" ? "desk" : href.slice(1)}`} className={match(path) ? "active" : ""}>
          <I />
          {label}
        </Link>
      ))}
      <ActiveJobWidget />
    </nav>
  );
}

