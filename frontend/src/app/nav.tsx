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

  const active = jobs.find((j) => j.status === "running" || j.status === "queued");
  if (!active) return null;

  const pct = Math.round((active.pct || 0) * 100);
  const indet = active.status === "queued" || !["vision", "backtest"].some((s) => active.stage.startsWith(s));

  return (
    <div
      style={{
        marginTop: 18,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(182, 156, 255, 0.08)",
        border: "1px solid rgba(182, 156, 255, 0.22)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontWeight: 600, color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent)",
              display: "inline-block",
              boxShadow: "0 0 8px var(--accent)",
            }}
          />
          {active.kind === "review" ? `Reviewing ${active.reel || "Reel"}` : active.kind}
        </span>
        {!indet && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}>{pct}%</span>}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {active.status === "queued" ? "Queued in background..." : stageLabel(active.stage)}
      </div>
      <div className={`progress ${indet ? "indet" : ""}`} style={{ width: "100%", height: 3 }}>
        <div style={{ width: `${pct}%` }} />
      </div>
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

