"use client";

import { useEffect, useState } from "react";
import { ago, clock } from "@/lib/format";

/** Ticks every second on the client. The first paint is a dash so SSR and the browser agree. */
export function Countdown({ deadline, label }: { deadline: number | null; label: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (deadline == null) return null;
  const left = now == null ? null : Math.floor((deadline - now) / 1000);
  const tone = left == null ? "" : left <= 0 ? "bad" : left < 30 ? "warn" : "";
  return (
    <span className="due">
      <span className="hint">{label}</span>
      <span className={`clock ${tone}`}>{left == null ? "—" : left <= 0 ? "0:00 · due" : clock(left)}</span>
    </span>
  );
}

export function ClientTime({ ms }: { ms: number | null }) {
  const [text, setText] = useState("—");
  useEffect(() => {
    if (ms == null) return;
    const tick = () => setText(ago(ms));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [ms]);
  if (ms == null) return null;
  return <span className="hint">{text}</span>;
}
