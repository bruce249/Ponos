"use client";

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Money, RefLinks } from "@/components/Money";
import { StateBadge } from "@/components/StateBadge";
import { ApiError, api, errorMessage } from "@/lib/api";
import { multiplyDollars } from "@/lib/format";
import type { ChainRefs } from "@/lib/links";
import { fundedAmount, normalizeBatches, type Batch, type CreateBatchBody } from "@/lib/shape";

const EMPTY = {
  title: "",
  pay: "40",
  count: "10",
  qaMode: "auto" as "auto" | "manual",
  reviewWindow: "120",
  workWindow: "120",
  revisionWindow: "120",
  rubric: "",
  goldQuestion: "",
  goldAnswer: "",
  prompt: "",
};

export default function LabPage() {
  const [form, setForm] = useState(EMPTY);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [funded, setFunded] = useState<{ amount: string; refs: ChainRefs } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api("/api/lab/batches");
      setBatches(normalizeBatches(body));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(errorMessage(e), 0, null));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  const set = (key: keyof typeof EMPTY) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }) as typeof prev);

  const preview = multiplyDollars(form.pay, Number(form.count));

  async function fund(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const count = Number(form.count);
    const reviewWindow = Number(form.reviewWindow);
    const workWindow = Number(form.workWindow);
    const revisionWindow = Number(form.revisionWindow);
    if (!form.title.trim() || !form.prompt.trim() || !form.rubric.trim()) {
      setFormError("Title, prompt, and rubric are required.");
      return;
    }
    if (!/^\d+(\.\d{1,6})?$/.test(form.pay.trim())) {
      setFormError("Pay must be a dollar amount, like 40 or 250.");
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      setFormError("Count must be a whole number of tasks.");
      return;
    }
    if ([reviewWindow, workWindow, revisionWindow].some((n) => !Number.isInteger(n) || n < 1)) {
      setFormError("Windows are whole seconds.");
      return;
    }
    if (form.qaMode === "auto" && (!form.goldQuestion.trim() || !form.goldAnswer.trim())) {
      setFormError("Auto QA needs a gold question and answer.");
      return;
    }
    const body: CreateBatchBody = {
      title: form.title.trim(),
      pay: form.pay.trim(),
      count,
      qaMode: form.qaMode,
      reviewWindow,
      workWindow,
      revisionWindow,
      rubric: form.rubric.trim(),
      goldQuestion: form.goldQuestion.trim(),
      goldAnswer: form.goldAnswer.trim(),
      prompt: form.prompt.trim(),
    };
    setBusy(true);
    try {
      const res = await api("/api/lab/batches", { method: "POST", body: JSON.stringify(body) });
      const view = fundedAmount(res, { pay: body.pay, count: body.count });
      setFunded({ amount: view.amount, refs: view.refs });
      setSubmitError(null);
      await load();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err : new ApiError(errorMessage(err), 0, null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="kicker">Lab</div>
      <h1>Lock the pay, then publish the work.</h1>
      <p className="lede">Create a batch and fund it in one step. The status table follows the escrow. It refreshes every 3 seconds.</p>

      <div className="notice warn">
        <b>Lab key is demo custody.</b>
        The server holds the lab account and signs the allowance and fundBatch transaction. This is a testnet demo.
      </div>

      {[loadError, submitError].map((error, i) =>
        error ? (
          error.status === 403 || error.status === 503 ? (
            <div className="notice bad" key={i}>
              <b>{error.status === 403 ? "Not allowed to fund" : "Lab API unavailable"}</b>
              {error.message}
            </div>
          ) : (
            <div className="notice bad" key={i}>
              {error.message}
            </div>
          )
        ) : null,
      )}

      {funded && (
        <div className="notice good">
          <b>
            Funded: $<Money amount={funded.amount} refs={funded.refs} prefer="tx" /> locked
          </b>
          <RefLinks refs={funded.refs} />
        </div>
      )}

      <form className="sheet" onSubmit={fund}>
        <div className="sheet-head">
          <h2>New batch</h2>
          <p className="sub">Pay is in dollars per task. Windows default to 120 seconds so a timeout can happen on camera.</p>
        </div>
        <div className="sheet-grid">
          <div>
            <label htmlFor="title">Title</label>
            <input id="title" value={form.title} onChange={set("title")} placeholder="Review Python solutions" maxLength={140} />
          </div>
          <div>
            <label htmlFor="qaMode">QA mode</label>
            <select id="qaMode" value={form.qaMode} onChange={set("qaMode")}>
              <option value="auto">auto</option>
              <option value="manual">manual</option>
            </select>
            <p className="hint">Auto grades the gold answer. Manual waits, so the scheduled release can be the thing that pays.</p>
          </div>
          <div>
            <label htmlFor="pay">Pay in dollars</label>
            <input id="pay" value={form.pay} onChange={set("pay")} inputMode="decimal" />
          </div>
          <div>
            <label htmlFor="count">Count</label>
            <input id="count" value={form.count} onChange={set("count")} inputMode="numeric" />
          </div>
          <div>
            <label htmlFor="reviewWindow">Review window (seconds)</label>
            <input id="reviewWindow" value={form.reviewWindow} onChange={set("reviewWindow")} inputMode="numeric" />
          </div>
          <div>
            <label htmlFor="workWindow">Work window (seconds)</label>
            <input id="workWindow" value={form.workWindow} onChange={set("workWindow")} inputMode="numeric" />
          </div>
          <div>
            <label htmlFor="revisionWindow">Revision window (seconds)</label>
            <input id="revisionWindow" value={form.revisionWindow} onChange={set("revisionWindow")} inputMode="numeric" />
          </div>
          <div>
            <label htmlFor="goldQuestion">Gold question</label>
            <input id="goldQuestion" value={form.goldQuestion} onChange={set("goldQuestion")} />
          </div>
          <div>
            <label htmlFor="prompt">Prompt</label>
            <textarea id="prompt" value={form.prompt} onChange={set("prompt")} placeholder="What the freelancer is asked to do." />
          </div>
          <div>
            <label htmlFor="rubric">Rubric</label>
            <textarea id="rubric" value={form.rubric} onChange={set("rubric")} placeholder="What a pass looks like." style={{ minHeight: 110 }} />
            <label htmlFor="goldAnswer">Gold answer</label>
            <input id="goldAnswer" value={form.goldAnswer} onChange={set("goldAnswer")} />
            <p className="hint">The gold answer stays on the server. It is not shown on the work desk.</p>
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Funding…" : "Create and fund"}
          </button>
          {preview && <span className="hint">Posted pay ${preview} before the platform fee. The funded total comes back from the escrow.</span>}
          {formError && <p className="hint" style={{ color: "var(--bad)" }}>{formError}</p>}
        </div>
      </form>

      <section className="band">
        <h2>Batches</h2>
        <p className="sub">Funded means the pay is locked. Open a transaction to see it on HashScan.</p>
        {!loaded && !loadError && (
          <p className="hint">
            <span className="spinner" /> Loading batches…
          </p>
        )}
        {loaded && !loadError && batches.length === 0 && <p className="empty">No batches yet. Fund one and it will show up here.</p>}
        {batches.length > 0 && (
          <ul className="batch-list">
            {batches.map((b) => (
              <li className="batch" key={b.id}>
                <div>{b.title}</div>
                <div className="hint mono">{b.id}</div>
                <dl>
                  <div>
                    <dt>Pay</dt>
                    <dd>{b.pay ? <Money amount={`$${b.pay}`} refs={b.refs} prefer="tx" /> : "—"}</dd>
                  </div>
                  <div>
                    <dt>Tasks</dt>
                    <dd>
                      {b.count ?? "—"}
                      {b.unclaimed != null && <div className="hint">{b.unclaimed} unclaimed</div>}
                    </dd>
                  </div>
                  <div>
                    <dt>QA</dt>
                    <dd>{b.qaMode || "—"}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <StateBadge state={b.status} />
                    </dd>
                  </div>
                  <div>
                    <dt>Locked</dt>
                    <dd>
                      {b.locked ? <Money amount={`$${b.locked}`} refs={b.refs} prefer="tx" /> : "—"}
                      <RefLinks refs={b.refs} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
