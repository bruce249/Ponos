"use client";

import { useCallback, useEffect, useState } from "react";
import { Countdown } from "@/components/Countdown";
import { Flash, type FlashNote } from "@/components/Flash";
import { Money, RefLinks } from "@/components/Money";
import { StateBadge } from "@/components/StateBadge";
import { ApiError, api, errorMessage } from "@/lib/api";
import { hashscanAccount } from "@/lib/links";
import { chainRefs, normalizeQueue, type ReviewItem } from "@/lib/shape";

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [flash, setFlash] = useState<FlashNote | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api("/api/review/queue");
      const q = normalizeQueue(body);
      setItems(q.items);
      setReviewer(q.reviewer);
      setError(null);
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(errorMessage(e), 0, null);
      if (ae.status === 403) {
        setItems([]);
        setReviewer(null);
      }
      setError(ae);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <>
      <div className="kicker">Reviewer entry</div>
      <h1>A reviewer can stop a large payment. They cannot stall it.</h1>
      <p className="lede">
        This desk is the allowlisted reviewer, labelled separately from the freelancer&apos;s World ID login. Approve pays now. Hold needs a written reason.
        Resolve splits a dispute: 0 sends the pay back to the lab, 10000 pays the freelancer in full.
      </p>

      <div className="card">
        <h2>Reviewer entry</h2>
        <p className="sub">The API returns 403 when this browser is not the reviewer. The queue refreshes every 3 seconds.</p>
        {reviewer && /^0\.0\.\d+$/.test(reviewer) ? (
          <p>
            Reviewer{" "}
            <a href={hashscanAccount(reviewer)} target="_blank" rel="noreferrer" className="mono">
              {reviewer} ↗
            </a>
          </p>
        ) : reviewer ? (
          <p>
            Reviewer <b>{reviewer}</b>
          </p>
        ) : (
          <p className="hint">No reviewer identity on this session yet.</p>
        )}
      </div>

      {error?.status === 403 && (
        <div className="notice bad" style={{ marginTop: 16 }}>
          <b>Not a reviewer</b>
          {error.message}
        </div>
      )}
      {error && error.status !== 403 && (
        <div className="notice bad" style={{ marginTop: 16 }}>
          {error.message}
        </div>
      )}
      <Flash flash={flash} />

      {loaded && !error && items.length === 0 && <div className="empty" style={{ marginTop: 16 }}>The reviewer queue is empty.</div>}
      {!loaded && !error && (
        <p className="hint" style={{ marginTop: 16 }}>
          <span className="spinner" /> Loading the queue…
        </p>
      )}

      <div className="stack" style={{ marginTop: 16 }}>
        {items.map((item) => (
          <ReviewCard key={item.taskId} item={item} onDone={(note) => { setFlash(note); void load(); }} />
        ))}
      </div>
    </>
  );
}

function ReviewCard({ item, onDone }: { item: ReviewItem; onDone: (note: FlashNote) => void }) {
  const [reason, setReason] = useState("");
  const [bps, setBps] = useState("10000");
  const [busy, setBusy] = useState<"approve" | "hold" | "resolve" | null>(null);
  const bpsNum = /^\d+$/.test(bps.trim()) ? Number(bps.trim()) : null;
  const bpsOk = bpsNum != null && bpsNum >= 0 && bpsNum <= 10000;

  async function act(kind: "approve" | "hold" | "resolve") {
    if (kind === "resolve" && (bpsNum == null || bpsNum < 0 || bpsNum > 10000)) return;
    if (kind === "hold" && reason.trim().length < 3) return;
    setBusy(kind);
    try {
      const path = `/api/review/${encodeURIComponent(item.taskId)}/${kind}`;
      const body = kind === "approve" ? {} : kind === "hold" ? { reason: reason.trim() } : { workerBps: bpsNum };
      const res = await api(path, { method: "POST", body: JSON.stringify(body) });
      const title = kind === "approve" ? (item.approvalsRequired > 1 && item.approvals + 1 < item.approvalsRequired ? "Approval recorded. A second reviewer must approve before pay is released early." : "Approved. The pay is released.") : kind === "hold" ? "Held. The task is disputed." : `Resolved at ${bpsNum} basis points to the worker.`;
      onDone({ kind: "good", title, refs: chainRefs(res, item.refs) });
    } catch (e) {
      onDone({ kind: "bad", title: "Review action failed", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>{item.title}</h2>
        <StateBadge state={item.state} />
        {item.pay && <Money amount={`$${item.pay}`} refs={item.refs} prefer="tx" />}
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        Task {item.taskId}
        {item.batchId ? ` · batch ${item.batchId}` : ""}
        {item.worker ? (
          <>
            {" "}
            · worker{" "}
            <a href={hashscanAccount(item.worker)} target="_blank" rel="noreferrer">
              {item.worker} ↗
            </a>
          </>
        ) : null}
      </p>
      <Countdown deadline={item.reviewDeadline} label="Review deadline" />
      {item.prompt && <div className="prompt">{item.prompt}</div>}
      {item.reason && <p className="hint">Reason on file: {item.reason}</p>}
      <RefLinks refs={item.refs} />

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn sm" disabled={busy != null} onClick={() => void act("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        {item.approvalsRequired > 1 && (
          <span className="hint">
            Two reviewers needed above this amount: {item.approvals}/{item.approvalsRequired} approved. Silence still pays the worker at the deadline.
          </span>
        )}
      </div>

      <label htmlFor={`reason-${item.taskId}`}>Hold reason</label>
      <textarea id={`reason-${item.taskId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this payout should stop." style={{ minHeight: 70 }} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm ghost" disabled={busy != null || reason.trim().length < 3} onClick={() => void act("hold")}>
          {busy === "hold" ? "Holding…" : "Hold"}
        </button>
      </div>

      <label htmlFor={`bps-${item.taskId}`}>Worker basis points (0–10000)</label>
      <div className="row">
        <input id={`bps-${item.taskId}`} className="grow" value={bps} onChange={(e) => setBps(e.target.value)} inputMode="numeric" />
        <button className="btn sm ghost" disabled={busy != null || !bpsOk} onClick={() => void act("resolve")}>
          {busy === "resolve" ? "Resolving…" : "Resolve"}
        </button>
      </div>
      <p className="hint">0 refunds the client. 10000 pays the worker the full amount. The fee follows the same split.</p>
    </article>
  );
}
