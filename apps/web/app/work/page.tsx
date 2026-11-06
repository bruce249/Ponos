"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Countdown, ClientTime } from "@/components/Countdown";
import { Flash, type FlashNote } from "@/components/Flash";
import { Money, RefLinks } from "@/components/Money";
import { StateBadge } from "@/components/StateBadge";
import { ApiError, api, errorMessage } from "@/lib/api";
import { extractCredited, inrText, payExceedsHundred, stateLabel } from "@/lib/format";
import { hashscanAccount, hashscanSchedule, stepUpHref, type ChainRefs } from "@/lib/links";
import { chainRefs, LOGGED_OUT, normalizeMe, normalizeWork, type FeedItem, type Me, type WorkTask } from "@/lib/shape";

export default function WorkPage() {
  return (
    <Suspense fallback={null}>
      <Work />
    </Suspense>
  );
}

function Work() {
  const params = useSearchParams();
  const handled = useRef(false);
  const [me, setMe] = useState<Me>(LOGGED_OUT);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [meError, setMeError] = useState<string | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashNote | null>(null);

  const load = useCallback(async () => {
    const [meRes, stateRes] = await Promise.allSettled([api("/api/me"), api("/api/work/state")]);
    if (meRes.status === "fulfilled") {
      setMe(normalizeMe(meRes.value));
      setMeError(null);
    } else if (meRes.reason instanceof ApiError && meRes.reason.status === 401) {
      setMe(LOGGED_OUT);
      setMeError(null);
    } else {
      setMeError(errorMessage(meRes.reason));
    }
    if (stateRes.status === "fulfilled") {
      const next = normalizeWork(stateRes.value);
      setFeed(next.feed);
      setTasks(next.tasks);
      setStateError(null);
    } else {
      setStateError(errorMessage(stateRes.reason));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (handled.current) return;
    const approval = params.get("approval");
    const action = params.get("action") ?? "";
    const target = params.get("target") ?? "";
    const denied = params.get("denied");
    const login = params.get("login");
    if (!approval && !denied && !login) return;
    handled.current = true;
    window.history.replaceState(null, "", "/work");

    if (login) {
      setFlash({ kind: "good", title: "Signed in with World ID." });
      void load();
      return;
    }
    if (denied) {
      setFlash({ kind: "bad", title: denied.replace(/_/g, " "), text: params.get("detail") ?? "" });
      void load();
      return;
    }
    if (!approval) return;

    void (async () => {
      try {
        if (action === "payout_wallet" || action === "payout") {
          const res = await api("/api/work/payout", { method: "POST", body: JSON.stringify({ approvalId: approval, accountId: target }) });
          setFlash({ kind: "good", title: "Payout account bound.", refs: chainRefs(res, { accountId: target }) });
        } else if (action === "claim_high") {
          const res = await api("/api/work/claim", { method: "POST", body: JSON.stringify({ approvalId: approval, batchId: target }) });
          setFlash({ kind: "good", title: "Task claimed.", refs: chainRefs(res) });
        } else {
          setFlash({ kind: "info", title: "World ID approval received.", text: action || undefined });
        }
      } catch (e) {
        setFlash({ kind: "bad", title: "Step-up did not finish", text: errorMessage(e) });
      } finally {
        void load();
      }
    })();
  }, [params, load]);

  async function logout() {
    try {
      await api("/api/world/logout", { method: "POST" });
      setMe(LOGGED_OUT);
      setFlash({ kind: "info", title: "Signed out." });
    } catch (e) {
      setFlash({ kind: "bad", title: "Could not sign out", text: errorMessage(e) });
    }
  }

  const walletRefs: ChainRefs = { ...me.refs, accountId: me.accountId ?? me.refs.accountId };

  return (
    <>
      <div className="kicker">Work</div>
      <h1>Claim the task. The deadline pays you if nobody else does.</h1>
      <p className="lede">Sign in with World ID, bind the account that should receive bUSD, then claim and submit.</p>

      {!me.signedIn && (
        <section className="band">
          <h2>World ID</h2>
          <p className="sub">One person, one account. The session cookie stays on this origin.</p>
          <a className="btn world" href="/api/world/login">
            Log in with World ID
          </a>
          <p className="hint">Sign in to see your bUSD balance and its rupee value.</p>
        </section>
      )}

      {meError && <div className="notice bad">{meError}</div>}
      {stateError && <div className="notice bad">{stateError}</div>}
      {me.banned && (
        <div className="notice bad">
          <b>This World ID is banned.</b>
          Claims and payout changes are blocked.
        </div>
      )}
      <Flash flash={flash} />

      <section className="band">
        <h2>Payout</h2>
        {me.signedIn ? (
          <div className="identity">
            <div className="row-line">
              <p>
                Signed in{me.verified ? " · verified human" : ""}.
                {me.accountId && (
                  <>
                    {" "}
                    Payout{" "}
                    <a href={hashscanAccount(me.accountId)} target="_blank" rel="noreferrer" className="mono">
                      {me.accountId} ↗
                    </a>
                  </>
                )}
              </p>
              <button className="btn ghost sm" type="button" onClick={() => void logout()}>
                Log out
              </button>
            </div>
            <div className="wallet-figs">
              <div className="fig">
                {me.busd ? <Money amount={`${me.busd} bUSD`} refs={walletRefs} prefer="token" className="" /> : <span className="hint">bUSD balance pending</span>}
              </div>
              <div className="fig">
                {me.inr ? <Money amount={inrText(me.inr)} refs={walletRefs} prefer="account" className="" /> : <span className="hint">Rupee value pending</span>}
              </div>
            </div>
            {me.fx && <p className="hint">{me.fx}</p>}
            <RefLinks refs={walletRefs} />
          </div>
        ) : (
          <p className="sub">Bind a payout account after you sign in. Pay is fixed to that account at claim time.</p>
        )}
        <PayoutCard accountId={me.accountId} />
      </section>

      <section className="band">
        <h2>Claim</h2>
        <p className="sub">Funded batches with something left to claim. Over $100, claim starts a claim_high World ID step-up.</p>
        {feed.length === 0 && <p className="empty">No funded unclaimed tasks right now.</p>}
        {feed.map((item) => (
          <FeedCard key={item.batchId} item={item} onDone={(note) => { setFlash(note); void load(); }} />
        ))}
      </section>

      <section className="band">
        <h2>Submit</h2>
        <p className="sub">State refreshes every 3 seconds. The review countdown moves every second without a reload.</p>
        {tasks.length === 0 && <p className="empty">You have no tasks in flight.</p>}
        {tasks.map((task) => (
          <TaskCard key={task.taskId} task={task} onDone={(note) => { setFlash(note); void load(); }} />
        ))}
      </section>

      <div className="tools">
        <FreezePanel onDone={setFlash} />
        <RedeemPanel onDone={() => void load()} />
      </div>
    </>
  );
}

function PayoutCard({ accountId }: { accountId: string | null }) {
  const [value, setValue] = useState("");
  const valid = /^0\.0\.\d+$/.test(value.trim());
  return (
    <div>
      <h3>Payout account</h3>
      <p className="sub">Enter a Hedera account id, then confirm it with the payout_wallet step-up. Pay is fixed to that account at claim time.</p>
      {accountId ? (
        <p>
          Bound to{" "}
          <a href={hashscanAccount(accountId)} target="_blank" rel="noreferrer" className="mono">
            {accountId} ↗
          </a>
        </p>
      ) : (
        <p className="hint">No payout account yet. Bind one before you claim.</p>
      )}
      <label htmlFor="payout-account">Account id</label>
      <div className="row">
        <input id="payout-account" className="grow" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.0.12345" />
        {valid ? (
          <a className="btn world" href={stepUpHref("payout_wallet", value.trim())}>
            Bind with World ID
          </a>
        ) : (
          <button className="btn" type="button" disabled>
            Bind with World ID
          </button>
        )}
      </div>
    </div>
  );
}

function FeedCard({ item, onDone }: { item: FeedItem; onDone: (note: FlashNote) => void }) {
  const [busy, setBusy] = useState(false);
  const high = payExceedsHundred(item.pay);

  async function claim() {
    setBusy(true);
    try {
      const res = await api("/api/work/claim", { method: "POST", body: JSON.stringify({ batchId: item.batchId }) });
      onDone({ kind: "good", title: "Task claimed.", refs: chainRefs(res, item.refs) });
    } catch (e) {
      onDone({ kind: "bad", title: "Claim failed", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="claim-row">
      <div className="row">
        <h3>{item.title}</h3>
        <StateBadge state="Funded" />
        {item.qaMode && <span className="badge plain">{item.qaMode}</span>}
      </div>
      <div>
        <Money amount={`$${item.pay}`} refs={item.refs} prefer="tx" />
        {item.unclaimed != null && <span className="hint"> · {item.unclaimed} unclaimed</span>}
        {item.count != null && item.unclaimed == null && <span className="hint"> · {item.count} tasks</span>}
      </div>
      {item.prompt && <p className="summary">{item.prompt}</p>}
      <RefLinks refs={item.refs} />
      <div className="row" style={{ marginTop: 10 }}>
        {high ? (
          <a className="btn sm world" href={stepUpHref("claim_high", item.batchId)}>
            Claim · step-up
          </a>
        ) : (
          <button className="btn sm" type="button" disabled={busy} onClick={() => void claim()}>
            {busy ? "Claiming…" : "Claim"}
          </button>
        )}
        {high && <span>Over $100 · claim_high</span>}
      </div>
    </article>
  );
}

function canSubmit(state: string): boolean {
  const key = state.toLowerCase().replace(/[\s_-]/g, "");
  return key === "claimed" || key === "revising";
}

function taskIdPayload(id: string): string | number {
  if (/^\d+$/.test(id) && id.length < 16) return Number(id);
  return id;
}

function logClass(title: string): string {
  const k = title.toLowerCase();
  if (/(release|approv|paid|fund|pass|claim|submit)/.test(k)) return "pay";
  if (/(fail|refund|hold|dispute)/.test(k)) return "bad";
  return "";
}

function TaskCard({ task, onDone }: { task: WorkTask; onDone: (note: FlashNote) => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const res = await api("/api/work/submit", {
        method: "POST",
        body: JSON.stringify({ taskId: taskIdPayload(task.taskId), body: body.trim() }),
      });
      setBody("");
      onDone({ kind: "good", title: "Submitted. The review deadline is set.", refs: chainRefs(res, task.refs) });
    } catch (err) {
      onDone({ kind: "bad", title: "Submit failed", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="task">
      <div className="row">
        <h3>{task.title}</h3>
        <StateBadge state={task.state} />
        {task.pay && <Money amount={`$${task.pay}`} refs={task.refs} prefer="tx" />}
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        Task {task.taskId}
        {task.batchId ? ` · batch ${task.batchId}` : ""}
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <Countdown deadline={task.reviewDeadline} label="Review deadline" />
        {canSubmit(task.state) && <Countdown deadline={task.workDeadline} label="Work deadline" />}
      </div>
      {task.refs.scheduleId && (
        <p style={{ marginTop: 8 }}>
          Release schedule{" "}
          <a href={hashscanSchedule(task.refs.scheduleId)} target="_blank" rel="noreferrer" className="mono">
            {task.refs.scheduleId} ↗
          </a>
        </p>
      )}
      {task.prompt && <div className="prompt">{task.prompt}</div>}
      <RefLinks refs={task.refs} />

      {canSubmit(task.state) && (
        <form onSubmit={submit}>
          <label htmlFor={`work-${task.taskId}`}>Your work</label>
          <textarea id={`work-${task.taskId}`} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write the answer. Only its hash goes on-chain." />
          <button className="btn" type="submit" disabled={busy || !body.trim()} style={{ marginTop: 10 }}>
            {busy ? "Submitting…" : "Submit"}
          </button>
        </form>
      )}

      {task.timeline.length > 0 && (
        <ol className="log" style={{ marginTop: 16 }}>
          {task.timeline.map((line, i) => (
            <li key={`${line.title}-${i}`} className={logClass(line.title)}>
              <div className="t">
                {stateLabel(line.title)}{" "}
                {line.amount && <Money amount={line.amount.includes("$") || line.amount.includes("₹") ? line.amount : `${line.amount} bUSD`} refs={line.refs} />}
              </div>
              <div className="d">
                {line.detail && <span>{line.detail} · </span>}
                <ClientTime ms={line.at} />
                <RefLinks refs={line.refs} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function FreezePanel({ onDone }: { onDone: (note: FlashNote) => void }) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  // Shown inside the panel: the page-level notice sits at the top, out of view when this panel is used.
  const [note, setNote] = useState<FlashNote | null>(null);
  const valid = /^0\.0\.\d+$/.test(accountId.trim());

  async function freeze(e: FormEvent) {
    e.preventDefault();
    const id = accountId.trim();
    setBusy(true);
    setNote(null);
    let result: FlashNote;
    try {
      const res = await api("/api/compliance/freeze", { method: "POST", body: JSON.stringify({ accountId: id }) });
      result = {
        kind: "good",
        title: `${id} is frozen for bUSD.`,
        text: "Signed by the compliance key (demo custody). Any bUSD transfer from this account is now refused by Hedera.",
        refs: chainRefs(res, { accountId: id }),
      };
    } catch (err) {
      const msg = errorMessage(err);
      result = /ACCOUNT_FROZEN_FOR_TOKEN/i.test(msg)
        ? { kind: "info", title: `${id} is already frozen.`, text: "Nothing changed. Check its token status on HashScan.", refs: { accountId: id } }
        : { kind: "bad", title: "Freeze failed", text: msg };
    } finally {
      setBusy(false);
    }
    setNote(result);
    onDone(result);
  }

  return (
    <form className="card" onSubmit={freeze}>
      <h2>Freeze</h2>
      <div className="notice warn">
        <b>Demo custody.</b>
        The server holds the compliance key and freezes this token account. Testnet only. Leave the escrow unfrozen.
      </div>
      <label htmlFor="freeze-account">Account id</label>
      <input id="freeze-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="0.0.12345" />
      <button className="btn" type="submit" disabled={!valid || busy} style={{ marginTop: 12 }}>
        {busy ? "Freezing…" : "Freeze account"}
      </button>
      <Flash flash={note} />
    </form>
  );
}

function RedeemPanel({ onDone }: { onDone: () => void }) {
  const [amount, setAmount] = useState("20");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [refs, setRefs] = useState<ChainRefs>({});
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d+(\.\d{1,6})?$/.test(amount.trim());

  async function redeem(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api("/api/redeem", { method: "POST", body: JSON.stringify({ amount: amount.trim() }) });
      setLine(extractCredited(res));
      setRefs(chainRefs(res));
      onDone();
    } catch (err) {
      setLine(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={redeem}>
      <h2>Redeem</h2>
      <div className="notice warn">
        <b>Simulated.</b>
        bUSD is burned on testnet and the reserve drops. The rupee credit is not a bank transfer.
      </div>
      <label htmlFor="redeem-amount">Amount (bUSD)</label>
      <input id="redeem-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      <button className="btn" type="submit" disabled={!valid || busy} style={{ marginTop: 12 }}>
        {busy ? "Redeeming…" : "Redeem"}
      </button>
      {line && (
        <div className="notice good" style={{ marginTop: 12 }}>
          <b>{line}</b>
          <RefLinks refs={refs} />
        </div>
      )}
      {error && <p className="hint" style={{ color: "var(--bad)" }}>{error}</p>}
    </form>
  );
}
