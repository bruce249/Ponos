/**
 * Every Hedera role account the demo uses, with the HBAR each one starts with.
 * `npm run keys` fills a missing <ROLE>_PRIVATE_KEY, `npm run accounts` creates a missing <ROLE>_ACCOUNT_ID.
 */
export const ROLE_PLAN = [
  { name: "SCS_ADMIN", hbar: 50 },
  { name: "CASHIN", hbar: 5 },
  { name: "BURN", hbar: 5 },
  { name: "COMPLIANCE", hbar: 5 },
  { name: "TREASURY", hbar: 2 },
  { name: "QA_POOL", hbar: 1 },
  { name: "ESCROW_ADMIN", hbar: 50 },
  { name: "BACKEND", hbar: 30 },
  { name: "QA_ORACLE", hbar: 10 },
  { name: "REVIEWER", hbar: 5 },
  // Second reviewer for the dual-review tier (DUAL_REVIEW_THRESHOLD).
  { name: "REVIEWER_B", hbar: 5 },
  { name: "LAB", hbar: 10 },
  { name: "WORKER_A", hbar: 1 },
  { name: "WORKER_B", hbar: 1 },
  { name: "WORKER_RENTED", hbar: 1 },
  { name: "AGENT", hbar: 20 },
] as const;
