"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api, API, BASIS_CLASS, Icon, mss, RevisionItem, RevisionNote, SEV_COLOR } from "../lib";

type Filter = "all" | "pending_editor" | "ready_nidhi" | "round_1" | "round_2" | "approved" | "unreviewed";

function NoteItem({
  reelKey,
  note,
  onToggle,
}: {
  reelKey: string;
  note: RevisionNote;
  onToggle: (key: string, noteId: string, field: "editor_done" | "nidhi_verified", val: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const handleEditorToggle = async () => {
    setBusy(true);
    try {
      await onToggle(reelKey, note.id, "editor_done", !note.editor_done);
    } finally {
      setBusy(false);
    }
  };

  const handleNidhiToggle = async () => {
    setBusy(true);
    try {
      await onToggle(reelKey, note.id, "nidhi_verified", !note.nidhi_verified);
    } finally {
      setBusy(false);
    }
  };

  const isVerified = note.nidhi_verified;
  const isFixed = note.editor_done;

  return (
    <div
      className={`p-4 rounded-xl border transition-all ${
        isVerified
          ? "border-emerald-500/30 bg-emerald-500/5 opacity-75"
          : isFixed
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-white/10 bg-black/20"
      }`}
      style={{ marginBottom: 10 }}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="mono text-xs font-semibold px-2 py-0.5 rounded bg-white/10 text-[var(--accent)]">
              {mss(note.t)}
              {note.end > note.t + 1 && ` → ${mss(note.end)}`}
            </span>
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{
                background: `${SEV_COLOR[note.severity] ?? "var(--muted)"}20`,
                color: SEV_COLOR[note.severity] ?? "var(--muted)",
                border: `1px solid ${SEV_COLOR[note.severity] ?? "var(--muted)"}40`,
              }}
            >
              {note.severity}
            </span>
            <span className="chip text-[11px] py-0">{note.category}</span>
            {note.basis && (
              <span className={`chip text-[11px] py-0 ${BASIS_CLASS[note.basis as keyof typeof BASIS_CLASS] ?? ""}`}>
                {note.basis}
              </span>
            )}
          </div>
          <div
            className={`text-sm leading-relaxed ${
              isVerified ? "line-through text-white/50" : "text-white/90"
            }`}
          >
            {note.note}
          </div>
        </div>

        {/* Dual Actions: Editor and Nidhi Checkboxes */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Editor Checkbox */}
          <button
            type="button"
            disabled={busy}
            onClick={handleEditorToggle}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
              isFixed
                ? "bg-amber-400/20 border-amber-400/40 text-amber-200"
                : "bg-white/5 border-white/10 text-white/60 hover:border-amber-400/30 hover:text-white"
            }`}
            title="Mark as corrected by the video editor"
          >
            <div
              className={`w-4 h-4 rounded flex items-center justify-center border text-[10px] ${
                isFixed ? "bg-amber-400 border-amber-400 text-black font-bold" : "border-white/30"
              }`}
            >
              {isFixed && "✓"}
            </div>
            <span>Fixed by Editor</span>
          </button>

          {/* Nidhi Checkbox */}
          <button
            type="button"
            disabled={busy}
            onClick={handleNidhiToggle}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
              isVerified
                ? "bg-emerald-400/20 border-emerald-400/40 text-emerald-200"
                : "bg-white/5 border-white/10 text-white/60 hover:border-emerald-400/30 hover:text-white"
            }`}
            title="Mark as verified & approved by Nidhi"
          >
            <div
              className={`w-4 h-4 rounded flex items-center justify-center border text-[10px] ${
                isVerified ? "bg-emerald-400 border-emerald-400 text-black font-bold" : "border-white/30"
              }`}
            >
              {isVerified && "✓"}
            </div>
            <span>Verified by Nidhi</span>
          </button>
        </div>
      </div>
    </div>
  );
}

type Candidate = {
  base: string;
  version: number;
  name: string;
  id: string;
  url: string;
};

function ConfirmV2Modal({
  reel,
  currentFileId,
  isOpen,
  onClose,
  onConfirmed,
}: {
  reel: string;
  currentFileId: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirmed: (data: { file_id: string; name: string; url: string; start_review: boolean }) => Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [startReview, setStartReview] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    api<{ candidates: Candidate[]; locked?: any }>(`/api/revisions/${reel}/candidates`)
      .then((res) => {
        setCandidates(res.candidates || []);
        const v2 = (res.candidates || []).find((c) => c.version >= 2 || c.id !== currentFileId) || res.candidates?.[0];
        if (v2) {
          setSelectedCandidate(v2);
          setIsCustom(false);
        } else {
          setIsCustom(true);
        }
      })
      .catch(() => setIsCustom(true))
      .finally(() => setLoading(false));
  }, [isOpen, reel, currentFileId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (isCustom) {
        if (!customUrl.trim()) return;
        const fid = customUrl.match(/\/d\/([\w-]{20,})|[?&]id=([\w-]{20,})/)?.[1] || customUrl.trim();
        await onConfirmed({
          file_id: fid,
          name: `${reel}_v2.mp4`,
          url: customUrl.trim(),
          start_review: startReview,
        });
      } else if (selectedCandidate) {
        await onConfirmed({
          file_id: selectedCandidate.id,
          name: selectedCandidate.name,
          url: selectedCandidate.url,
          start_review: startReview,
        });
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(8px)",
        zIndex: 9999,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="panel panel-pad"
        style={{ maxWidth: 540, width: "100%", animation: "rise 0.25s var(--ease) both" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div className="eyebrow">Review 2 Video Check</div>
            <h2 className="h2" style={{ marginTop: 2 }}>Confirm Video for Reel {reel}</h2>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <div style={{ padding: "30px 0", textAlign: "center" }}>
            <span className="spin" style={{ display: "inline-block", marginBottom: 8 }} />
            <div className="faint" style={{ fontSize: 13 }}>Checking Google Drive for v2 files...</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
            {selectedCandidate && !isCustom ? (
              <div
                style={{
                  padding: 16,
                  borderRadius: 14,
                  background: "rgba(182, 156, 255, 0.08)",
                  border: "1px solid rgba(182, 156, 255, 0.25)",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", marginBottom: 6 }}>
                  Detected Version 2 Video in Drive:
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "white", marginBottom: 4 }}>
                  🎬 {selectedCandidate.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
                  <span className="chip c-ok" style={{ height: 20, fontSize: 11 }}>Version {selectedCandidate.version}</span>
                  <a
                    href={selectedCandidate.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--info)", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    Open / Preview in Drive ↗
                  </a>
                </div>

                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "white", marginBottom: 8 }}>
                    Is this the correct video for Review 2?
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      style={{ flex: 1 }}
                      onClick={() => setIsCustom(false)}
                    >
                      ✓ Yes, this is v2
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      style={{ border: "1px solid var(--line)" }}
                      onClick={() => setIsCustom(true)}
                    >
                      No, use different link
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                style={{
                  padding: 16,
                  borderRadius: 14,
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid var(--line)",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "white", marginBottom: 6 }}>
                  Enter v2 Video Link:
                </div>
                <input
                  type="url"
                  required
                  placeholder="https://drive.google.com/file/d/.../view"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="textarea"
                  style={{ minHeight: 42, padding: "8px 12px", fontFamily: "inherit" }}
                />
                {selectedCandidate && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginTop: 8, fontSize: 11 }}
                    onClick={() => setIsCustom(false)}
                  >
                    ← Back to detected file ({selectedCandidate.name})
                  </button>
                )}
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={startReview}
                onChange={(e) => setStartReview(e.target.checked)}
                style={{ accentColor: "var(--accent)", width: 16, height: 16 }}
              />
              <span>Trigger AI Review 2 analysis immediately</span>
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Locking & Starting..." : "Confirm & Lock as v2"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ReelRevisionCard({
  item,
  onToggle,
  onConfirmV2,
  onAddNote,
  onStartReview,
}: {
  item: RevisionItem;
  onToggle: (key: string, noteId: string, field: "editor_done" | "nidhi_verified", val: boolean) => Promise<void>;
  onConfirmV2: (key: string, data: { file_id: string; name: string; url: string; start_review: boolean }) => Promise<void>;
  onAddNote: (key: string, text: string) => Promise<void>;
  onStartReview?: (key: string, url?: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [customText, setCustomText] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [v2ModalOpen, setV2ModalOpen] = useState(false);
  const [startingReview, setStartingReview] = useState(false);

  const total = item.notes.length;
  const editorDoneCount = item.notes.filter((n) => n.editor_done).length;
  const nidhiVerifiedCount = item.notes.filter((n) => n.nidhi_verified).length;
  const isApproved = (total > 0 && nidhiVerifiedCount === total) || item.status === "approved";
  const isReadyForNidhi = total > 0 && editorDoneCount === total && !isApproved;
  const isUnreviewed = (total === 0 && item.status !== "approved") || item.status === "unreviewed";

  const handleTriggerReview = async () => {
    if (!onStartReview) return;
    setStartingReview(true);
    try {
      await onStartReview(item.reel, item.url);
    } finally {
      setStartingReview(false);
    }
  };

  const copyNotes = async (onlyPending = false) => {
    const list = onlyPending ? item.notes.filter((n) => !n.nidhi_verified) : item.notes;
    const text = list
      .map(
        (n) =>
          `${mss(n.t)} - ${n.note}${n.editor_done ? " [Fixed by Editor]" : ""}${
            n.nidhi_verified ? " [Verified by Nidhi]" : ""
          }`
      )
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim()) return;
    await onAddNote(item.reel, customText.trim());
    setCustomText("");
    setShowCustomInput(false);
  };

  return (
    <div className="panel overflow-hidden transition-all duration-300" style={{ marginBottom: 20 }}>
      {/* Header */}
      <div className="p-5 flex items-center justify-between gap-4 flex-wrap border-b border-white/5 bg-white/[0.02]">
        <div className="flex items-center gap-3.5 flex-wrap">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-xs text-white/70"
          >
            {expanded ? "▼" : "▶"}
          </button>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="mono text-base font-bold text-white tracking-tight">
                Reel {item.reel}
              </span>
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${
                  item.round === 1
                    ? "bg-purple-500/15 border-purple-500/30 text-purple-300"
                    : "bg-indigo-500/15 border-indigo-500/30 text-indigo-300"
                }`}
              >
                Review {item.round}
              </span>
              {isApproved ? (
                <span className="chip c-ok text-xs">
                  <i /> Approved &amp; Verified
                </span>
              ) : isReadyForNidhi ? (
                <span className="chip c-info text-xs">
                  <i /> Ready for Nidhi Verification
                </span>
              ) : isUnreviewed ? (
                <span className="chip c-warn text-xs">
                  <i /> Unreviewed / Waiting
                </span>
              ) : (
                <span className="chip c-warn text-xs">
                  <i /> Pending Editor Fixes ({editorDoneCount}/{total})
                </span>
              )}
            </div>
            <div className="text-xs text-white/40 mt-1">
              {item.editor && `Editor: ${item.editor} · `}
              {total > 0
                ? `${total} items · ${nidhiVerifiedCount} verified by Nidhi · ${editorDoneCount} fixed by Editor`
                : isUnreviewed
                ? "No review report yet"
                : "No issues flagged"}
            </div>
            {item.v2_video?.confirmed && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4, padding: "2px 8px", borderRadius: 8, background: "rgba(182, 156, 255, 0.1)", border: "1px solid rgba(182, 156, 255, 0.25)", fontSize: 11, color: "var(--accent)" }}>
                <span>🔒 Locked to v2: <strong>{item.v2_video.name}</strong></span>
                <button
                  type="button"
                  onClick={() => setV2ModalOpen(true)}
                  style={{ marginLeft: 6, textDecoration: "underline", color: "var(--muted)", cursor: "pointer", background: "none", border: "none", fontSize: 10.5 }}
                >
                  Change
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {isUnreviewed && (item.url || item.file_id) && (
            <button
              onClick={handleTriggerReview}
              disabled={startingReview}
              className="btn btn-sm btn-primary text-xs"
              title="Launch AI Review now"
            >
              {startingReview ? <span className="spin" /> : "▶"} {startingReview ? "Queuing..." : "Start Review"}
            </button>
          )}

          {item.file_id && (
            <Link
              href={`/report?id=${item.file_id}`}
              className="btn btn-sm btn-ghost hover:bg-white/5 text-xs text-white/80"
            >
              <Icon.play /> Watch &amp; Report
            </Link>
          )}

          {total > 0 && (
            <button
              onClick={() => copyNotes(false)}
              className="btn btn-sm text-xs"
              title="Copy all notes for this reel"
            >
              {copied ? <Icon.check /> : <Icon.copy />} {copied ? "Copied" : "Copy Notes"}
            </button>
          )}

          <button
            onClick={() => setV2ModalOpen(true)}
            className="btn btn-sm text-xs bg-indigo-500/10 border-indigo-500/30 hover:bg-indigo-500/20 text-indigo-300"
            title="Confirm v2 video and advance to Review 2"
          >
            ⏩ {item.round === 1 ? "Advance to Review 2" : `Review ${item.round + 1}`}
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-white/5 h-1.5 relative overflow-hidden">
        <div
          className="h-full bg-amber-400 transition-all duration-500 absolute left-0"
          style={{ width: `${total ? (editorDoneCount / total) * 100 : 0}%` }}
        />
        <div
          className="h-full bg-emerald-400 transition-all duration-500 absolute left-0"
          style={{ width: `${total ? (nidhiVerifiedCount / total) * 100 : 0}%` }}
        />
      </div>

      {/* Body Content */}
      {expanded && (
        <div className="p-5">
          {item.notes.length === 0 ? (
            <div className="py-8 text-center text-sm text-white/40">
              {isUnreviewed ? (
                <div style={{ display: "grid", gap: 10, placeItems: "center" }}>
                  <div>This reel has not been reviewed by the AI agent yet.</div>
                  {(item.url || item.file_id) ? (
                    <button
                      onClick={handleTriggerReview}
                      disabled={startingReview}
                      className="btn btn-sm btn-primary"
                    >
                      {startingReview ? <span className="spin" /> : "▶"} {startingReview ? "Queuing Review..." : "Run AI Review Now"}
                    </button>
                  ) : (
                    <span className="faint text-xs">No video link attached in Google Sheet yet.</span>
                  )}
                </div>
              ) : (
                <div>No notes recorded for this reel. It is approved!</div>
              )}
            </div>
          ) : (
            <div>
              {item.notes.map((note) => (
                <NoteItem
                  key={note.id}
                  reelKey={item.reel}
                  note={note}
                  onToggle={onToggle}
                />
              ))}
            </div>
          )}

          {/* Add custom note or view history */}
          <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-3">
              {showCustomInput ? (
                <form onSubmit={handleAddCustom} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customText}
                    onChange={(e) => setCustomText(e.target.value)}
                    placeholder="Enter manual note/comment..."
                    className="bg-black/30 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white min-w-[260px] focus:outline-none focus:border-purple-400"
                    autoFocus
                  />
                  <button type="submit" className="btn btn-sm btn-primary">
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCustomInput(false)}
                    className="btn btn-sm btn-ghost"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setShowCustomInput(true)}
                  className="btn btn-sm btn-ghost text-white/60 hover:text-white"
                >
                  <Icon.plus /> Add Manual Note
                </button>
              )}
            </div>

            {item.history && item.history.length > 0 && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="btn btn-sm btn-ghost text-white/60 hover:text-white flex items-center gap-1.5"
              >
                <Icon.history /> {showHistory ? "Hide Past Rounds" : `Past Rounds (${item.history.length})`}
              </button>
            )}
          </div>

          {/* Past Rounds Archive */}
          {showHistory && item.history && item.history.length > 0 && (
            <div className="mt-4 p-4 rounded-xl bg-black/40 border border-white/10 space-y-3">
              <div className="text-xs font-bold text-white/70 uppercase tracking-wider">
                Revision History Archive
              </div>
              {item.history.map((h, idx) => (
                <div key={idx} className="p-3 rounded-lg bg-white/[0.02] border border-white/5 text-xs">
                  <div className="flex justify-between items-center text-white/60 mb-2">
                    <span className="font-semibold text-purple-300">Round {h.round}</span>
                    <span>{h.completed_at}</span>
                  </div>
                  <div className="space-y-1 text-white/50">
                    {h.notes.map((hn, hidx) => (
                      <div key={hidx} className="line-through">
                        {mss(hn.t)} - {hn.note}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmV2Modal
        reel={item.reel}
        currentFileId={item.file_id}
        isOpen={v2ModalOpen}
        onClose={() => setV2ModalOpen(false)}
        onConfirmed={async (data) => {
          await onConfirmV2(item.reel, data);
        }}
      />
    </div>
  );
}

function NotesRepoContent() {
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("filter") as Filter || "all";
  const targetReel = searchParams.get("reel");

  const [revisions, setRevisions] = useState<Record<string, RevisionItem>>({});
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [query, setQuery] = useState(targetReel || "");
  const [loading, setLoading] = useState(true);
  const [copiedAll, setCopiedAll] = useState(false);
  const [toast, setToast] = useState("");

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 3000);
  };

  const load = useCallback(async () => {
    try {
      const res = await api<{ revisions: Record<string, RevisionItem> }>("/api/revisions");
      setRevisions(res.revisions || {});
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const handleToggle = async (
    key: string,
    noteId: string,
    field: "editor_done" | "nidhi_verified",
    val: boolean
  ) => {
    try {
      const updated = await api<RevisionItem>("/api/revisions/toggle", {
        method: "POST",
        body: JSON.stringify({ key, note_id: noteId, field, value: val }),
      });
      setRevisions((prev) => ({ ...prev, [key]: updated }));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const handleConfirmV2 = async (
    key: string,
    data: { file_id: string; name: string; url: string; start_review: boolean }
  ) => {
    try {
      const res = await api<{ ok: boolean; revision: RevisionItem; job?: any }>("/api/revisions/confirm-v2", {
        method: "POST",
        body: JSON.stringify({
          key,
          file_id: data.file_id,
          name: data.name,
          url: data.url,
          start_review: data.start_review,
        }),
      });
      setRevisions((prev) => ({ ...prev, [key]: res.revision }));
      flash(data.start_review ? `Reel ${key} locked to v2 & Review 2 started!` : `Reel ${key} locked to v2!`);
      load();
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const handleAddNote = async (key: string, text: string) => {
    try {
      const updated = await api<RevisionItem>("/api/revisions/note", {
        method: "POST",
        body: JSON.stringify({ key, text }),
      });
      setRevisions((prev) => ({ ...prev, [key]: updated }));
      flash(`Added note to Reel ${key}`);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const handleStartReview = async (reelKey: string, url?: string) => {
    try {
      flash(`Starting AI review for Reel ${reelKey}...`);
      await api("/api/review", {
        method: "POST",
        body: JSON.stringify({
          urls: url ? [url] : [],
          reels: [reelKey],
          rerun: true,
        }),
      });
      flash(`AI Review queued for Reel ${reelKey}!`);
      load();
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const [syncing, setSyncing] = useState(false);
  const handleSyncSheet = async () => {
    setSyncing(true);
    try {
      flash("Syncing Google Sheet & Drive files...");
      await api("/api/sync", { method: "POST" });
      await load();
      flash("Successfully synced sheet & Drive!");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const itemsList = useMemo(() => Object.values(revisions), [revisions]);

  const stats = useMemo(() => {
    let round1 = 0;
    let round2 = 0;
    let pendingEditor = 0;
    let readyNidhi = 0;
    let approved = 0;
    let unreviewed = 0;

    for (const item of itemsList) {
      const total = item.notes.length;
      const editorCount = item.notes.filter((n) => n.editor_done).length;
      const nidhiCount = item.notes.filter((n) => n.nidhi_verified).length;
      const isApproved = (total > 0 && nidhiCount === total) || item.status === "approved";
      const isReadyNidhi = total > 0 && editorCount === total && !isApproved;
      const isPendingEditor = total > 0 && editorCount < total;
      const isUnreviewed = (total === 0 && item.status !== "approved") || item.status === "unreviewed";
      const isActiveReview = !isApproved && !isUnreviewed;

      if (item.round === 1 && isActiveReview) round1++;
      if (item.round > 1 && isActiveReview) round2++;

      if (isApproved) {
        approved++;
      } else if (isReadyNidhi) {
        readyNidhi++;
      } else if (isPendingEditor) {
        pendingEditor++;
      } else if (isUnreviewed) {
        unreviewed++;
      }
    }

    return { total: itemsList.length, round1, round2, pendingEditor, readyNidhi, approved, unreviewed };
  }, [itemsList]);

  const filteredItems = useMemo(() => {
    return itemsList.filter((item) => {
      // Filter tab
      const total = item.notes.length;
      const editorCount = item.notes.filter((n) => n.editor_done).length;
      const nidhiCount = item.notes.filter((n) => n.nidhi_verified).length;
      const isApproved = (total > 0 && nidhiCount === total) || item.status === "approved";
      const isReadyNidhi = total > 0 && editorCount === total && !isApproved;
      const isPendingEditor = total > 0 && editorCount < total;
      const isUnreviewed = (total === 0 && item.status !== "approved") || item.status === "unreviewed";
      const isActiveReview = !isApproved && !isUnreviewed;

      if (filter === "round_1" && (item.round !== 1 || !isActiveReview)) return false;
      if (filter === "round_2" && (item.round <= 1 || !isActiveReview)) return false;
      if (filter === "pending_editor" && !isPendingEditor) return false;
      if (filter === "ready_nidhi" && !isReadyNidhi) return false;
      if (filter === "approved" && !isApproved) return false;
      if (filter === "unreviewed" && !isUnreviewed) return false;

      // Text query
      if (query.trim()) {
        const q = query.toLowerCase();
        const matchesReel = item.reel?.toLowerCase().includes(q);
        const matchesEditor = item.editor?.toLowerCase().includes(q);
        const matchesNote = item.notes.some((n) => n.note.toLowerCase().includes(q));
        if (!matchesReel && !matchesEditor && !matchesNote) return false;
      }

      return true;
    });
  }, [itemsList, filter, query]);

  const copyAllUnresolved = async () => {
    const lines: string[] = [];
    for (const item of itemsList) {
      const pending = item.notes.filter((n) => !n.nidhi_verified);
      if (pending.length) {
        lines.push(`\n=== Reel ${item.reel} (Review ${item.round}) ===`);
        for (const n of pending) {
          lines.push(`${mss(n.t)} - ${n.note}${n.editor_done ? " [Fixed by Editor]" : ""}`);
        }
      }
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
    flash("Copied all pending changes to clipboard!");
  };

  return (
    <div className="page">
      {/* Toast Alert */}
      {toast && (
        <div
          className="banner c-ok"
          style={{ position: "fixed", bottom: 24, right: 24, zIndex: 100, maxWidth: 380 }}
        >
          <Icon.check /> {toast}
        </div>
      )}

      {/* Header */}
      <header className="mb-8">
        <div className="eyebrow">Revision Tracker &amp; Notes Repository</div>
        <h1 className="h1">
          Review 1 &amp; Review 2 <em>Notes Desk</em>
        </h1>
        <p className="lede">
          Track corrections across iterations. Video editors tick changes made, Nidhi verifies and
          approves, and unresolved notes roll forward cleanly into Review 2.
        </p>
      </header>

      {/* Stats Cards */}
      <div className="grid-stats">
        <div className="panel stat">
          <div className="eyebrow">All Reels</div>
          <div className="stat-n">{stats.total}</div>
          <div className="stat-bar" style={{ background: "var(--accent)" }} />
        </div>
        <div className="panel stat">
          <div className="eyebrow">Review 1 Active</div>
          <div className="stat-n text-purple-300">{stats.round1}</div>
          <div className="stat-bar" style={{ background: "var(--accent-2)" }} />
        </div>
        <div className="panel stat">
          <div className="eyebrow">Needs Editor Fixes</div>
          <div className="stat-n text-amber-300">{stats.pendingEditor}</div>
          <div className="stat-bar" style={{ background: "var(--warn)" }} />
        </div>
        <div className="panel stat">
          <div className="eyebrow">Ready for Nidhi</div>
          <div className="stat-n text-emerald-300">{stats.readyNidhi}</div>
          <div className="stat-bar" style={{ background: "var(--ok)" }} />
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="panel panel-pad mb-6 flex items-center justify-between gap-4 flex-wrap">
        <div className="seg flex-wrap">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            All ({itemsList.length})
          </button>
          <button
            className={filter === "pending_editor" ? "on" : ""}
            onClick={() => setFilter("pending_editor")}
          >
            Needs Editor ({stats.pendingEditor})
          </button>
          <button
            className={filter === "ready_nidhi" ? "on" : ""}
            onClick={() => setFilter("ready_nidhi")}
          >
            Needs Nidhi ({stats.readyNidhi})
          </button>
          <button className={filter === "round_1" ? "on" : ""} onClick={() => setFilter("round_1")}>
            Review 1 ({stats.round1})
          </button>
          <button className={filter === "round_2" ? "on" : ""} onClick={() => setFilter("round_2")}>
            Review 2 ({stats.round2})
          </button>
          <button className={filter === "approved" ? "on" : ""} onClick={() => setFilter("approved")}>
            Approved ({stats.approved})
          </button>
          <button className={filter === "unreviewed" ? "on" : ""} onClick={() => setFilter("unreviewed")}>
            Unreviewed ({stats.unreviewed})
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search reel, editor, or note..."
            className="bg-black/30 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white min-w-[200px] focus:outline-none focus:border-purple-400"
          />
          <button
            onClick={handleSyncSheet}
            disabled={syncing}
            className="btn btn-sm btn-ghost"
            style={{ border: "1px solid var(--line)" }}
            title="Sync latest rows from Google Sheets & Drive"
          >
            {syncing ? <span className="spin" /> : "🔄"} {syncing ? "Syncing..." : "Sync Sheet"}
          </button>
          <button onClick={copyAllUnresolved} className="btn btn-sm btn-primary">
            {copiedAll ? <Icon.check /> : <Icon.copy />} {copiedAll ? "Copied" : "Copy Pending Fixes"}
          </button>
        </div>
      </div>

      {/* Main List */}
      {loading ? (
        <div className="text-center py-20">
          <span className="spin inline-block mb-3" />
          <div className="text-white/40 text-sm">Loading notes repository...</div>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="panel p-12 text-center text-white/40">
          No reels match this filter or search query.
        </div>
      ) : (
        <div>
          {filteredItems.map((item) => (
            <ReelRevisionCard
              key={item.reel}
              item={item}
              onToggle={handleToggle}
              onConfirmV2={handleConfirmV2}
              onAddNote={handleAddNote}
              onStartReview={handleStartReview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function NotesRepoPage() {
  return (
    <Suspense
      fallback={
        <div className="page text-center py-20 text-white/40">
          <span className="spin inline-block mb-2" />
          Loading revision desk...
        </div>
      }
    >
      <NotesRepoContent />
    </Suspense>
  );
}
