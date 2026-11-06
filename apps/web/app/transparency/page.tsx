"use client";

import { useCallback, useEffect, useState } from "react";
import { ClientTime } from "@/components/Countdown";
import { Money, RefLinks } from "@/components/Money";
import { api, errorMessage } from "@/lib/api";
import { stateLabel } from "@/lib/format";
import { hashscanAccount } from "@/lib/links";
import { normalizeTransparency, type TransparencyView } from "@/lib/shape";

function logClass(title: string): string {
  const k = title.toLowerCase();
  if (/(release|approv|paid|fund|pass)/.test(k)) return "pay";
  if (/(fail|refund|hold|dispute)/.test(k)) return "bad";
  return "";
}

export default function TransparencyPage() {
  const [data, setData] = useState<TransparencyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(normalizeTransparency(await api("/api/transparency")));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  const figs = data ? [data.reserve, data.nav, data.supply, data.valueLocked] : [];

  return (
    <>
      <div className="kicker">Transparency</div>
      <h1>The reserve, the escrow, and every decision.</h1>
      <p className="lede">
        Reserve, NAV, supply, and value locked come from the public feed. The HCS log and the contributor score refresh every 3 seconds. Each money figure opens
        HashScan.
      </p>

      <p className="hint">
        <span className="spinner" /> Live · every 3s
      </p>
      {error && <div className="notice bad">{error}</div>}

      <div className="grid2" style={{ marginTop: 8 }}>
        {(figs.length ? figs : [null, null, null, null]).map((fig, i) => {
          const labels = ["Reserve", "NAV", "Supply", "Value locked"];
          return (
            <div className="stat" key={labels[i]}>
              <div className="k">{fig?.label ?? labels[i]}</div>
              <div className="v">
                {fig ? (
                  <Money
                    amount={fig.unit ? `${fig.amount} ${fig.unit}` : fig.amount}
                    refs={fig.refs}
                    prefer={fig.label === "Value locked" ? "contract" : fig.label === "Supply" ? "token" : "tx"}
                    className=""
                  />
                ) : (
                  "—"
                )}
              </div>
              {fig && <RefLinks refs={fig.refs} />}
            </div>
          );
        })}
      </div>

      <div className="cols" style={{ marginTop: 20 }}>
        <section className="card">
          <h2>HCS log</h2>
          <p className="sub">One message per task transition. No personal data. The message link is the topic sequence on HashScan.</p>
          {data && data.log.length === 0 && <div className="empty">No task messages yet.</div>}
          {data && data.log.length > 0 && (
            <ol className="log">
              {data.log.map((line, i) => (
                <li key={`${line.title}-${line.at ?? i}-${i}`} className={logClass(line.title)}>
                  <div className="t">
                    {stateLabel(line.title)}{" "}
                    {line.amount && <Money amount={line.amount.includes("$") ? line.amount : `${line.amount} bUSD`} refs={line.refs} prefer="tx" />}
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
          {!data && !error && (
            <p className="hint">
              <span className="spinner" /> Loading the log…
            </p>
          )}
        </section>

        <section className="card">
          <h2>Contributor score</h2>
          <p className="sub">Recomputed from the HCS log. The account link is the payout account, which is already public on the token transfer.</p>
          {data && data.leaderboard.length === 0 && <div className="empty">No scores yet.</div>}
          {data && data.leaderboard.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Account</th>
                    <th>Score</th>
                    <th>Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {data.leaderboard.map((row, i) => (
                    <tr key={row.accountId || i}>
                      <td>{i + 1}</td>
                      <td>
                        {row.accountId ? (
                          <a href={hashscanAccount(row.accountId)} target="_blank" rel="noreferrer" className="mono">
                            {row.accountId} ↗
                          </a>
                        ) : (
                          row.name ?? "—"
                        )}
                        {row.name && row.accountId && <div className="hint">{row.name}</div>}
                      </td>
                      <td className="mono">{row.score}</td>
                      <td>{row.paid ? <Money amount={`$${row.paid}`} refs={row.refs} prefer="tx" /> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
