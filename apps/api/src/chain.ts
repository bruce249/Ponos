/**
 * Contract calls: viem encodes the calldata, the Hedera SDK submits it
 * as a ContractExecuteTransaction from the role account. Revert data is
 * decoded into the Solidity error name so the UI can show it.
 */
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  Status,
} from "@hiero-ledger/sdk";
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Hex,
} from "viem";
import { bytes32ToAscii, escrowAbi, MIRROR_NODE, parseHederaKey, type HederaNetwork } from "@byline-work/shared";
import { config, type RoleName } from "./config";

const clients = new Map<string, Client>();

export class NotConfigured extends Error {
  constructor(feature: string, readonly missing: string[]) {
    super(`${feature} is not configured: ${missing.join(", ")}`);
    this.name = "NotConfigured";
  }
}

export class EscrowCallError extends Error {
  constructor(readonly errorMessage: string, readonly txId: string) {
    super(errorMessage);
    this.name = "EscrowCallError";
  }
}

export function hederaClient(accountId: string, privateKey: string): Client {
  const hit = clients.get(accountId);
  if (hit) return hit;
  const c = config.hedera.network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
  c.setOperator(AccountId.fromString(accountId), parseHederaKey(privateKey) as unknown as PrivateKey);
  c.setDefaultMaxTransactionFee(new Hbar(20));
  clients.set(accountId, c);
  return c;
}

export function evmAddressFromKey(privateKey: string): Hex {
  const key = parseHederaKey(privateKey) as unknown as { publicKey: { toEvmAddress: () => string } };
  const addr = key.publicKey.toEvmAddress();
  return (addr.startsWith("0x") ? addr : `0x${addr}`) as Hex;
}

const ROLE_PREFIX: Record<RoleName, string> = {
  operator: "OPERATOR",
  scsAdmin: "SCS_ADMIN",
  cashin: "CASHIN",
  burn: "BURN",
  compliance: "COMPLIANCE",
  treasury: "TREASURY",
  qaPool: "QA_POOL",
  escrowAdmin: "ESCROW_ADMIN",
  backend: "BACKEND",
  qaOracle: "QA_ORACLE",
  reviewer: "REVIEWER",
  lab: "LAB",
  workerA: "WORKER_A",
  workerB: "WORKER_B",
  workerRented: "WORKER_RENTED",
  agent: "AGENT",
};

export function requireRole(role: RoleName): { accountId: string; privateKey: string } {
  const r = config.roles[role];
  const missing: string[] = [];
  const prefix = ROLE_PREFIX[role];
  if (!r.accountId) missing.push(`${prefix}_ACCOUNT_ID`);
  if (!r.privateKey) missing.push(`${prefix}_PRIVATE_KEY`);
  if (missing.length) throw new NotConfigured(prefix.toLowerCase(), missing);
  return { accountId: r.accountId, privateKey: r.privateKey };
}

export function requireEscrow(): void {
  if (!config.escrow.contractId) throw new NotConfigured("escrow", ["ESCROW_CONTRACT_ID"]);
}

function decodeRevert(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const data = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 10) return trimmed;
  try {
    const decoded = decodeErrorResult({ abi: escrowAbi, data });
    const args = decoded.args?.length ? `(${decoded.args.map((a) => String(a)).join(", ")})` : "";
    return `${decoded.errorName}${args}`;
  } catch {
    return trimmed;
  }
}

export async function executeContract(opts: {
  accountId: string;
  privateKey: string;
  contractId: string;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  gas?: number;
}): Promise<{ txId: string; result: unknown }> {
  const data = encodeFunctionData({ abi: opts.abi, functionName: opts.functionName, args: opts.args as never });
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(opts.contractId))
    .setGas(opts.gas ?? 1_500_000)
    .setFunctionParameters(Buffer.from(data.slice(2), "hex"));
  const client = hederaClient(opts.accountId, opts.privateKey);
  const response = await tx.execute(client);
  const txId = response.transactionId.toString();
  let receipt;
  try {
    receipt = await response.getReceipt(client);
  } catch (e: unknown) {
    let message = e instanceof Error ? e.message : String(e);
    try {
      const record = await response.getRecord(client);
      const raw = record.contractFunctionResult?.errorMessage;
      if (raw) message = decodeRevert(raw) || message;
    } catch {
      /* the receipt error is the best we have */
    }
    throw new EscrowCallError(message, txId);
  }
  if (receipt.status !== Status.Success) {
    throw new EscrowCallError(receipt.status.toString(), txId);
  }
  let result: unknown = null;
  try {
    const record = await response.getRecord(client);
    const bytes = record.contractFunctionResult?.bytes;
    if (bytes && bytes.length > 0) {
      const encoded = `0x${Buffer.from(bytes).toString("hex")}` as Hex;
      result = decodeFunctionResult({ abi: opts.abi, functionName: opts.functionName, data: encoded });
    }
  } catch {
    result = null;
  }
  return { txId, result };
}

export function mirrorBase(): string {
  return MIRROR_NODE[config.hedera.network as HederaNetwork];
}

export async function mirrorGet(path: string): Promise<unknown> {
  const res = await fetch(`${mirrorBase()}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`mirror node ${res.status} ${path}`);
  return res.json();
}

export type AccountInfo = {
  accountId: string;
  evmAddress: Hex;
  maxAutoAssoc: number;
  balanceTinybar: bigint;
};

export async function accountInfo(accountId: string): Promise<AccountInfo | null> {
  const res = await fetch(`${mirrorBase()}/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node ${res.status} for ${accountId}`);
  const data = (await res.json()) as {
    account: string;
    evm_address: string;
    max_automatic_token_associations: number;
    balance: { balance: number };
  };
  const evm = data.evm_address.startsWith("0x") ? data.evm_address : `0x${data.evm_address}`;
  return {
    accountId: data.account,
    evmAddress: evm as Hex,
    maxAutoAssoc: data.max_automatic_token_associations,
    balanceTinybar: BigInt(data.balance?.balance ?? 0),
  };
}

export async function tokenBalance(accountId: string, tokenId: string): Promise<bigint> {
  const data = (await mirrorGet(`/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}&limit=1`)) as {
    tokens?: { balance: number }[];
  };
  return BigInt(data.tokens?.[0]?.balance ?? 0);
}

export function knownAccountByEvm(evm: string): string | null {
  const want = evm.toLowerCase();
  for (const role of Object.values(config.roles)) {
    if (!role.privateKey || !role.accountId) continue;
    try {
      if (evmAddressFromKey(role.privateKey).toLowerCase() === want) return role.accountId;
    } catch {
      /* unparsable key */
    }
  }
  return null;
}

export function pathOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return bytes32ToAscii(value);
}

export { Status };
