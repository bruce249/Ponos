import { stateLabel, stateTone } from "@/lib/format";

export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${stateTone(state)}`}>{stateLabel(state)}</span>;
}
