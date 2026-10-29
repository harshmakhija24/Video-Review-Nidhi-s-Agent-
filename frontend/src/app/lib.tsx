// Shared types, API helper and small UI pieces for the reviewer frontend.
import type { ReactNode } from "react";

export const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail ?? msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/** Nidhi's timestamp style: m.ss (16s -> 0.16). */
export const mss = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}.${String(s % 60).padStart(2, "0")}`;
};

export type Job = {
  id: string; kind: "review" | "backtest" | "learn"; status: "queued" | "running" | "waiting" | "done" | "failed";
  stage: string; pct: number; reel?: string | null; url?: string; file_id?: string;
  verdict?: string; notes?: number; error?: string; created: number; writer?: string; retry_at?: number; partial?: boolean;
};

export type RevisionNote = {
  id: string;
  t: number;
  end: number;
  note: string;
  category: string;
  severity: "high" | "medium" | "low";
  basis: string;
  rule?: string;
  editor_done: boolean;
  editor_comment?: string;
  nidhi_verified: boolean;
  nidhi_comment?: string;
};

export type RevisionRound = {
  round: number;
  completed_at: string;
  notes: RevisionNote[];
  total: number;
  editor_done: number;
  nidhi_verified: number;
};

export type RevisionItem = {
  reel: string;
  file_id: string;
  editor: string;
  round: number;
  status: "pending_fixes" | "ready_for_review" | "approved" | "unreviewed";
  notes: RevisionNote[];
  history?: RevisionRound[];
  url?: string;
  created_at?: string;
  updated_at?: number;
  v2_video?: {
    file_id: string;
    name: string;
    url: string;
    confirmed: boolean;
    confirmed_at: string;
  };
};

export type Reel = {
  reel: string; status: string; editor: string; notes: string; link: string; file_id: string | null;
  drive_name: string | null; version: number | null;
  agent: { verdict: string; notes: number; created: string } | null; job: Job | null;
  revision?: {
    round: number;
    status: "pending_fixes" | "ready_for_review" | "approved" | "unreviewed";
    total: number;
    editor_done: number;
    nidhi_verified: number;
  } | null;
};

export type Note = {
  t: number; end: number; category: string; severity: "high" | "medium" | "low";
  basis: "observed" | "predicted" | "technical"; rule: string; note: string; evidence?: string;
};

export type Report = {
  reel: string | null; editor: string | null; url: string; file_id: string; verdict: "Approved" | "Correction" | "Incomplete";
  summary: string; notes: Note[]; dropped: Note[]; skipped: string[]; writer: string; partial?: boolean; retry_at?: number;
  media: { duration: number; width: number; height: number; fps: number; cuts: number[] };
  frames: { t: number; file: string; caption: string | null; shot: string | null }[];
  transcript: string; transcript_source: string | null; created: string;
};

export type Rule = {
  id: string; category: string; rule: string; basis: "observed" | "predicted"; status: "active" | "rejected";
  confidence: number; because?: string; examples: { reel: string; editor: string; note: string }[]; decided?: boolean;
};

export const STAGE_LABEL: Record<string, string> = {
  queued: "Queued", downloading: "Downloading", analysing: "Analysing video & audio", transcribing: "Transcribing",
  vision: "Watching frames", checking: "Running checks", writing: "Writing notes", done: "Done",
};

export function stageLabel(s: string) {
  return STAGE_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

export function Verdict({ v }: { v?: string | null }) {
  if (!v) return <span className="chip">—</span>;
  const cls = v === "Approved" ? "c-ok" : v === "Correction" ? "c-bad" : "c-info";
  return <span className={`chip ${cls}`}><i />{v}</span>;
}

export function SheetStatus({ s }: { s: string }) {
  const cls = s === "Approved" ? "c-ok" : s === "Correction" ? "c-bad" : "c-warn";
  return <span className={`chip ${cls}`}><i />{s || "—"}</span>;
}

export const SEV_COLOR = { high: "var(--bad)", medium: "var(--warn)", low: "var(--info)" } as const;
export const BASIS_CLASS = { observed: "c-acc", predicted: "c-warn", technical: "c-info" } as const;

const P = (d: ReactNode) => (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={p.className}>{d}</svg>
);
export const Icon = {
  desk: P(<><rect x="3" y="4" width="18" height="14" rx="3" /><path d="M8 21h8M10 9l4 2.5L10 14z" /></>),
  book: P(<><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5M9 7h6" /></>),
  play: P(<path d="M7 4l13 8-13 8z" />),
  check: P(<path d="M5 12.5l4.5 4.5L19 7" />),
  x: P(<path d="M6 6l12 12M18 6L6 18" />),
  alert: P(<><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.01" /></>),
  copy: P(<><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>),
  checklist: P(<><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /><path d="M4 8h4M4 12h3M4 16h4" /></>),
  plus: P(<><path d="M12 5v14M5 12h14" /></>),
  history: P(<><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /><path d="M3.05 11a9 9 0 0 1 .5-2m-.5 2H7" /></>),
  back: P(<path d="M15 5l-7 7 7 7" />),
  down: P(<path d="M6 9l6 6 6-6" />),
  spark: P(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />),
  refresh: P(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>),
  link: P(<><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>),
};
