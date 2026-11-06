import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { escrowAbi } from "../src/escrow-abi";

const artifact = fileURLToPath(new URL("../../../contracts/out/EscrowVault.sol/EscrowVault.json", import.meta.url));

type AbiItem = { type: string; name?: string; inputs?: readonly { type: string; indexed?: boolean }[] };

/** Signature that also captures `indexed`, so the indexer's topic decoding cannot drift. */
function sig(item: AbiItem): string {
  const inputs = (item.inputs ?? []).map((i) => `${i.type}${i.indexed ? " indexed" : ""}`).join(",");
  return `${item.type} ${item.name ?? ""}(${inputs})`;
}

test("TS escrow ABI matches every error, event and called function in the compiled contract", { skip: !existsSync(artifact) && "run forge build first" }, () => {
  const compiled = (JSON.parse(readFileSync(artifact, "utf8")) as { abi: AbiItem[] }).abi;
  const onChain = new Set(compiled.map(sig));
  const ours = (escrowAbi as readonly AbiItem[]).map(sig);
  const drift = ours.filter((s) => !onChain.has(s));
  assert.deepEqual(drift, [], `TS ABI entries missing from the contract: ${drift.join("; ")}`);

  const needed = compiled.filter((i) => i.type === "error" || i.type === "event").map(sig);
  const missing = needed.filter((s) => !ours.includes(s));
  assert.deepEqual(missing, [], `contract errors/events missing from the TS ABI: ${missing.join("; ")}`);
});
