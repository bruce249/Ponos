import { formatUnits } from "viem";

export function short(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return "";
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function clock(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleString();
}

/** Dollar string -> 6-decimal atomic units. Rejects anything that is not a plain decimal. */
export function parseMicro(input: string): bigint | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const micros = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(micros || "0");
}

export function formatMicro(micro: bigint): string {
  return formatUnits(micro, 6);
}

export function tidyDecimal(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function multiplyDollars(pay: string, count: number): string | null {
  const micro = parseMicro(pay);
  if (micro == null || !Number.isInteger(count) || count < 1) return null;
  return tidyDecimal(formatMicro(micro * BigInt(count)));
}

/** True when the posted pay is strictly over $100. */
export function payExceedsHundred(pay: string): boolean {
  const micro = parseMicro(pay);
  if (micro == null) return false;
  return micro > 100n * 1_000_000n;
}

export function stateLabel(state: string): string {
  return state.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function stateTone(state: string): "good" | "warn" | "bad" | "info" | "plain" {
  const key = state.toLowerCase().replace(/[\s_-]/g, "");
  if (key === "released" || key === "qapass" || key === "approved" || key === "funded") return "good";
  if (key === "submitted" || key === "awaitingapproval" || key === "revising" || key === "claimed") return "warn";
  if (key === "failed" || key === "disputed" || key === "held" || key === "banned") return "bad";
  if (key === "resolved" || key === "open") return "info";
  return "plain";
}

export function inrText(value: string): string {
  const v = value.trim();
  return v.startsWith("₹") ? v : `₹${v}`;
}

/** Pull the server's "₹ … credited (simulated)" line out of a redeem response. */
export function extractCredited(body: unknown): string | null {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") found.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(body);
  return found.find((s) => s.toLowerCase().includes("credited")) ?? found.find((s) => s.includes("₹")) ?? null;
}
