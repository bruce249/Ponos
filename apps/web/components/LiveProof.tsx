"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { DEPLOYED } from "@/lib/deployed";
import { hashscanContract, hashscanToken, hashscanTopic, hashscanTopicMessage } from "@/lib/links";

type Stats = {
  tasksPaid: number;
  tasksInFlight: number;
  medianSecondsToPay: number | null;
  autoReleaseShare: number;
  hcsLatest: number | null;
};

type Live = {
  valueLocked: string | null;
  supply: string | null;
  contractId: string | null;
  tokenId: string | null;
  topicId: string | null;
  stats?: Stats;
};

function duration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function num(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v;
}

export function LiveProof() {
  const [live, setLive] = useState<Live | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const body = await api<Live>("/api/transparency");
        if (!stop) {
          setLive(body);
          setDown(false);
        }
      } catch {
        if (!stop) setDown(true);
      }
    };
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const contractId = live?.contractId ?? DEPLOYED.contractId;
  const tokenId = live?.tokenId ?? DEPLOYED.tokenId;
  const topicId = live?.topicId ?? DEPLOYED.topicId;
  const s = live?.stats;

  const cells = [
    { k: "Locked in escrow", v: live ? `${num(live.valueLocked)}` : "—", unit: "bUSD", href: hashscanContract(contractId) },
    { k: "Tasks paid", v: s ? String(s.tasksPaid) : "—", unit: s?.tasksInFlight ? `${s.tasksInFlight} in flight` : "", href: hashscanContract(contractId) },
    { k: "Median time to pay", v: s ? duration(s.medianSecondsToPay) : "—", unit: "submit → paid", href: hashscanTopic(topicId) },
    { k: "Paid with no human", v: s ? `${Math.round(s.autoReleaseShare * 100)}%` : "—", unit: "QA pass or deadline", href: hashscanTopic(topicId) },
    {
      k: "On the public log",
      v: s?.hcsLatest ? s.hcsLatest.toLocaleString("en-US") : "—",
      unit: "HCS messages",
      href: s?.hcsLatest ? hashscanTopicMessage(topicId, s.hcsLatest) : hashscanTopic(topicId),
    },
  ];

  return (
    <section className="proof" aria-label="Live figures from Hedera testnet">
      <div className="proof-head">
        <span className={down ? "pulse off" : "pulse"} aria-hidden="true" />
        {down ? "Live figures are unavailable right now" : "Live from Hedera testnet · refreshes every 10 s"}
        <a href={hashscanToken(tokenId)} target="_blank" rel="noreferrer">
          bUSD {tokenId} ↗
        </a>
      </div>
      <div className="proof-grid">
        {cells.map((c) => (
          <a key={c.k} className="proof-cell" href={c.href} target="_blank" rel="noreferrer">
            <span className="k">{c.k}</span>
            <span className="v">{c.v}</span>
            <span className="u">{c.unit}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
