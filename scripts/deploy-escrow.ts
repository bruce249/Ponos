/**
 * Deploys EscrowVault with ContractCreateFlow. Constructor arguments are ABI-encoded
 * with viem and passed without a function selector.
 *   npm run deploy:escrow
 * Refuses to run if forge has not written the bytecode. Does not run forge.
 */
import { readFileSync } from "node:fs";
import { AccountId, Client, ContractCreateFlow, ContractId, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, type Hex } from "viem";
import { parseHederaKey } from "@byline-work/shared";
import { config } from "../apps/api/src/config";
import { evmAddressFromKey } from "../apps/api/src/chain";
import { grantRole, associateEscrowToken } from "../apps/api/src/escrow";
import { die, missing, need } from "./lib";

const absent = missing([
  "OPERATOR_ACCOUNT_ID",
  "OPERATOR_PRIVATE_KEY",
  "ESCROW_ADMIN_ACCOUNT_ID",
  "ESCROW_ADMIN_PRIVATE_KEY",
  "BUSD_TOKEN_ID",
  "TREASURY_ACCOUNT_ID",
  "TREASURY_PRIVATE_KEY",
  "QA_POOL_ACCOUNT_ID",
  "QA_POOL_PRIVATE_KEY",
  "BACKEND_PRIVATE_KEY",
  "QA_ORACLE_PRIVATE_KEY",
  "REVIEWER_PRIVATE_KEY",
]);
if (absent.length) die(`Cannot deploy. Missing: ${absent.join(", ")}`);

const artifactPath = "contracts/out/EscrowVault.sol/EscrowVault.json";
let artifact: { bytecode?: { object?: string } };
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch {
  die(`Bytecode not found at ${artifactPath}. The chain owner runs forge build. This script does not.`);
}
const bytecode = artifact.bytecode?.object;
if (!bytecode || bytecode === "0x") die(`No bytecode in ${artifactPath}.`);

function evmOf(id: { toEvmAddress(): string }): Hex {
  const hex = id.toEvmAddress();
  return (hex.startsWith("0x") ? hex : `0x${hex}`) as Hex;
}

const token = evmOf(AccountId.fromString(need("BUSD_TOKEN_ID")));
const treasury = evmAddressFromKey(need("TREASURY_PRIVATE_KEY"));
const qaPool = evmAddressFromKey(need("QA_POOL_PRIVATE_KEY"));
const admin = evmAddressFromKey(need("ESCROW_ADMIN_PRIVATE_KEY"));
const scheduling = (process.env.ESCROW_SCHEDULING || "hip1215") === "hip1215";
const hitl = BigInt(process.env.HITL_THRESHOLD || "100");
const hitlBase = hitl >= 1_000_000n ? hitl : hitl * 1_000_000n;
const encoded = encodeAbiParameters(
  parseAbiParameters("address, address, address, address, uint64, uint16, uint16, uint32, uint32, uint32, bool, uint256"),
  [
    token,
    treasury,
    qaPool,
    admin,
    hitlBase,
    Number(process.env.PLATFORM_FEE_BPS || "300"),
    Number(process.env.QA_POOL_SHARE_BPS || "3333"),
    Number(process.env.MIN_WINDOW_SEC || "120"),
    Number(process.env.MAX_WINDOW_SEC || "2592000"),
    Number(process.env.DISPUTE_WINDOW_SEC || "600"),
    scheduling,
    BigInt(process.env.HBAR_LOW_TINYBAR || "500000000"),
  ],
);

const client = adminClient();
const created = await new ContractCreateFlow()
  .setBytecode(bytecode)
  .setGas(8_000_000)
  .setConstructorParameters(Buffer.from(encoded.slice(2), "hex"))
  .setInitialBalance(new Hbar(20))
  .execute(client);
const receipt = await created.getReceipt(client);
const contractId = receipt.contractId?.toString() ?? "";
if (!contractId) die("Contract create returned no contract id.");
const address = evmOf(ContractId.fromString(contractId));
console.log(`ESCROW_CONTRACT_ID=${contractId}`);
console.log(`ESCROW_ADDRESS=${address}`);
console.log(`# https://hashscan.io/testnet/contract/${contractId}`);

process.env.ESCROW_CONTRACT_ID = contractId;
process.env.ESCROW_ADDRESS = address;
config.escrow.contractId = contractId;
config.escrow.address = address;
try {
  const associated = await associateEscrowToken();
  console.log(`# associate tx: ${associated.txId}`);
} catch (e: unknown) {
  console.error(`Deployed, but associateToken failed: ${e instanceof Error ? e.message : e}`);
}
const backend = evmAddressFromKey(need("BACKEND_PRIVATE_KEY"));
const qa = evmAddressFromKey(need("QA_ORACLE_PRIVATE_KEY"));
const reviewer = evmAddressFromKey(need("REVIEWER_PRIVATE_KEY"));
const role = (name: string) => keccak256(stringToBytes(name));
for (const [hash, account] of [
  [role("VERIFIER"), backend],
  [role("RELAYER"), backend],
  [role("QA_ORACLE"), qa],
  [role("REVIEWER"), reviewer],
] as const) {
  const granted = await grantRole(hash, account);
  console.log(`# grant ${account} tx ${granted.txId}`);
}
client.close();

function adminClient(): Client {
  const network = process.env.HEDERA_NETWORK || "hedera:testnet";
  const c = network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
  c.setOperator(AccountId.fromString(need("ESCROW_ADMIN_ACCOUNT_ID")), parseHederaKey(need("ESCROW_ADMIN_PRIVATE_KEY")) as unknown as PrivateKey);
  return c;
}
