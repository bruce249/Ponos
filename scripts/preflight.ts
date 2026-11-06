/**
 * Says what is configured and what the next testnet step needs. Reads .env only; sends nothing.
 *   npm run preflight
 */
import { existsSync } from "node:fs";
import { missing } from "./lib";

type Step = { name: string; command: string; needs: string[]; note?: string };

const roles = ["SCS_ADMIN", "CASHIN", "BURN", "COMPLIANCE", "TREASURY", "QA_POOL", "ESCROW_ADMIN", "BACKEND", "QA_ORACLE", "REVIEWER", "LAB", "WORKER_A", "WORKER_B", "WORKER_RENTED", "AGENT"];
const roleVars = roles.flatMap((r) => [`${r}_ACCOUNT_ID`, `${r}_PRIVATE_KEY`]);

const steps: Step[] = [
  { name: "0a. feed signer key", command: "npm run keys", needs: [], note: "prints FEED_SIGNER_KEY" },
  { name: "0b. role accounts", command: "npm run accounts", needs: ["OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY"], note: "needs about 580 testnet HBAR on the operator" },
  { name: "0c. HCS topic", command: "npm run topic", needs: ["OPERATOR_ACCOUNT_ID", "OPERATOR_PRIVATE_KEY"] },
  { name: "0d. create bUSD (spike S1)", command: "npm run busd", needs: ["SCS_FACTORY_ADDRESS", "SCS_RESOLVER_ADDRESS", "SCS_ADMIN_ACCOUNT_ID", "SCS_ADMIN_PRIVATE_KEY", "CASHIN_ACCOUNT_ID", "BURN_ACCOUNT_ID", "COMPLIANCE_ACCOUNT_ID", "TREASURY_ACCOUNT_ID"], note: "factory and resolver come from the Stablecoin Studio testnet deployment" },
  { name: "1a. forge build", command: "cd contracts && forge build", needs: [] },
  { name: "1b. deploy escrow", command: "npm run deploy:escrow", needs: ["ESCROW_ADMIN_ACCOUNT_ID", "ESCROW_ADMIN_PRIVATE_KEY", "BUSD_TOKEN_ID", "TREASURY_PRIVATE_KEY", "QA_POOL_PRIVATE_KEY", "BACKEND_PRIVATE_KEY", "QA_ORACLE_PRIVATE_KEY", "REVIEWER_PRIVATE_KEY"], note: "set ESCROW_SCHEDULING first (hip1215 | sdk | keeper)" },
  { name: "1c. KYC the escrow, treasury, QA pool", command: "npm run lifecycle -- kyc <id>", needs: ["COMPLIANCE_ACCOUNT_ID", "COMPLIANCE_PRIVATE_KEY", "BUSD_TOKEN_ID", "ESCROW_CONTRACT_ID"], note: "demo-seed does this for you" },
  { name: "2. seed one take", command: "npm run demo-seed", needs: ["LAB_ACCOUNT_ID", "WORKER_A_ACCOUNT_ID", "BUSD_RESERVE_ADDRESS", "ESCROW_CONTRACT_ID", "ESCROW_ADDRESS", "HCS_TOPIC_ID"] },
  { name: "3. headless paths (G2)", command: "npm run e2e", needs: ["ESCROW_CONTRACT_ID", "ESCROW_ADDRESS", "HCS_TOPIC_ID", "QA_ORACLE_PRIVATE_KEY", "REVIEWER_PRIVATE_KEY"] },
  { name: "4. x402 NAV buy (G4)", command: "npm run dev:api  then  npm run buy-nav", needs: ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY", "FEED_SIGNER_KEY", "HCS_TOPIC_ID"] },
];

console.log(`.env present: ${existsSync(".env") ? "yes" : "NO. cp .env.example .env"}`);
const roleGaps = missing(roleVars);
console.log(`role accounts: ${roleVars.length - roleGaps.length}/${roleVars.length} variables set${roleGaps.length ? ` (run npm run accounts, missing e.g. ${roleGaps.slice(0, 3).join(", ")})` : ""}`);
console.log(`ESCROW_SCHEDULING=${process.env.ESCROW_SCHEDULING || "hip1215 (default)"}`);
console.log(`optional: REVIEWER2 (dual review) ${missing(["REVIEWER2_ACCOUNT_ID", "REVIEWER2_PRIVATE_KEY"]).length ? "not set" : "set"}, WORLD_CLIENT_ID ${process.env.WORLD_CLIENT_ID ? "set" : "not set (use DEMO_MOCK_WORLD=1)"}, ZG_API_KEY ${process.env.ZG_API_KEY ? "set" : "not set"}`);
console.log("");
let next: string | null = null;
for (const step of steps) {
  const gaps = missing(step.needs);
  const ready = gaps.length === 0;
  if (ready && next === null) next = step.name;
  console.log(`${ready ? "ready  " : "blocked"}  ${step.name.padEnd(40)} ${step.command}${ready ? "" : `   missing: ${gaps.join(", ")}`}${step.note ? `   (${step.note})` : ""}`);
}
console.log("");
console.log("Ready does not mean done: this only checks variables. Record each spike's tx ids in BYLINE_WORK_BUILD.md section 2.");
