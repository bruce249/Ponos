import Link from "next/link";
import { LiveProof } from "@/components/LiveProof";
import { DEPLOYED } from "@/lib/deployed";
import { hashscanContract, hashscanSchedule, hashscanToken, hashscanTopic, hashscanTx } from "@/lib/links";

const STEPS = [
  {
    n: "01",
    title: "Lock",
    text: "The lab funds the batch. The escrow pulls the pay and the 3% fee in bUSD before anyone can claim a task.",
    tech: "EscrowVault · HTS",
  },
  {
    n: "02",
    title: "Claim",
    text: "A worker signs in with World ID and binds a payout account. Claiming a task over $100 takes a fresh verification.",
    tech: "World ID step-up",
  },
  {
    n: "03",
    title: "Submit",
    text: "The work stays off-chain and its hash goes on-chain. In the same call, the escrow schedules its own payout.",
    tech: "Scheduled Transactions · HIP-1215",
  },
  {
    n: "04",
    title: "Paid",
    text: "QA passes or a reviewer approves: paid now. Nobody acts: the schedule pays at the deadline. Only a hold with a reason stops it.",
    tech: "Release · HCS log",
  },
];

const PROOFS = [
  {
    what: "The escrow contract",
    why: "Source verified on HashScan (Sourcify exact match). Holds every locked dollar.",
    id: DEPLOYED.contractId,
    href: hashscanContract(DEPLOYED.contractId),
  },
  {
    what: "bUSD, the stablecoin",
    why: "Issued with Stablecoin Studio. KYC, freeze, pause and wipe keys, a reserve, and a custom fee.",
    id: DEPLOYED.tokenId,
    href: hashscanToken(DEPLOYED.tokenId),
  },
  {
    what: "The public log",
    why: "One HCS message per task transition. No personal data. The contributor score is computed from it.",
    id: DEPLOYED.topicId,
    href: hashscanTopic(DEPLOYED.topicId),
  },
  {
    what: "A payout made by silence",
    why: "Nobody reviewed. The contract's own schedule fired after the deadline and paid the worker 40 bUSD.",
    id: "schedule 0.0.11341648",
    href: hashscanSchedule("0.0.11341648"),
  },
  {
    what: "An agent paying for data",
    why: "x402 on Hedera: 0.001 HBAR for the NAV feed, settled by Blocky402, no human approving.",
    id: "0.0.7162784@1793996607.990961596",
    href: hashscanTx("0.0.7162784@1793996607.990961596"),
  },
];

const STACK = [
  {
    name: "Hedera",
    role: "The money and the rules",
    parts: ["Stablecoin Studio", "HTS custom fee", "EVM escrow", "Scheduled Transactions (HIP-1215)", "Consensus Service", "x402 payments", "Mirror Node"],
  },
  {
    name: "World ID",
    role: "One human, fresh consent",
    parts: ["One account per person", "Step-up to claim over $100", "Step-up to change the payout wallet"],
  },
  {
    name: "0G",
    role: "A second opinion on QA",
    parts: ["Rubric check on 0G compute", "Request id kept in the QA report", "The pay decision stays deterministic"],
  },
];

const DESKS = [
  { href: "/lab", index: "01", name: "Lab", title: "Fund the batch", text: "Post the work, the pay, and the rubric. The escrow locks the money first." },
  { href: "/work", index: "02", name: "Work", title: "Claim and submit", text: "World ID, a payout account, and a live countdown to your scheduled pay." },
  { href: "/review", index: "03", name: "Review", title: "Approve, hold, or split", text: "Over $100 a reviewer decides. A hold needs a reason. Doing nothing still pays." },
  { href: "/transparency", index: "04", name: "Ledger", title: "Reserve, NAV, and the log", text: "Supply, value locked, the live HCS log, and the contributor score." },
];

export default function HomePage() {
  return (
    <div className="home">
      <section className="hero">
        <p className="live-pill">
          <span className="pulse" aria-hidden="true" /> Live on Hedera testnet
        </p>
        <h1 className="hero-title">
          Silence pays
          <br />
          <em>the freelancer.</em>
        </h1>
        <p className="hero-lede">
          Escrowed payroll for the people who train AI. A lab locks dollars on Hedera before the work starts. When you submit, the escrow schedules your pay. If
          nobody reviews in time, Hedera pays you anyway.
        </p>
        <div className="hero-cta">
          <Link className="btn lg" href="/work">
            Claim a task
          </Link>
          <Link className="btn lg line" href="/lab">
            Fund a batch
          </Link>
          <Link className="text-link" href="/transparency">
            Open the ledger →
          </Link>
        </div>
      </section>

      <LiveProof />

      <section className="deadline" aria-labelledby="deadline-h">
        <div className="section-head">
          <p className="kicker">The mechanism</p>
          <h2 id="deadline-h">The deadline is the default, not the reviewer.</h2>
          <p className="section-lede">
            Freelance platforms hold pay until someone clicks approve. Here the payout is already scheduled on-chain when the work is submitted. A reviewer can
            pay early or hold with a reason. Doing nothing pays the worker.
          </p>
        </div>
        <ol className="track" aria-label="What happens after a worker submits">
          <li className="mark start">
            <span className="dot" />
            <b>Submitted</b>
            <span>Work hash on-chain. Release scheduled.</span>
          </li>
          <li className="window">
            <span className="bar" />
            <b>Review window</b>
            <span>QA grades. A reviewer may approve now, or hold with a reason.</span>
          </li>
          <li className="mark">
            <span className="dot" />
            <b>Deadline</b>
            <span>Public, and counted down on the Work desk.</span>
          </li>
          <li className="mark end">
            <span className="dot" />
            <b>Paid</b>
            <span>Hedera runs the schedule. No server has to be up.</span>
          </li>
        </ol>
      </section>

      <section aria-labelledby="flow-h">
        <div className="section-head">
          <p className="kicker">How a task gets paid</p>
          <h2 id="flow-h">Four steps, all of them public.</h2>
        </div>
        <ol className="steps4">
          {STEPS.map((s) => (
            <li key={s.n}>
              <span className="n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <span className="tech">{s.tech}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="verify-h">
        <div className="section-head">
          <p className="kicker">Check it yourself</p>
          <h2 id="verify-h">Don&apos;t trust this page. Open HashScan.</h2>
        </div>
        <ul className="proofs">
          {PROOFS.map((p) => (
            <li key={p.what}>
              <a href={p.href} target="_blank" rel="noreferrer">
                <span className="what">{p.what}</span>
                <span className="why">{p.why}</span>
                <span className="id">{p.id} ↗</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="stack-h">
        <div className="section-head">
          <p className="kicker">Built with</p>
          <h2 id="stack-h">Each partner does one job.</h2>
        </div>
        <div className="stack3">
          {STACK.map((s) => (
            <div key={s.name} className="stack-col">
              <h3>{s.name}</h3>
              <p className="role">{s.role}</p>
              <ul>
                {s.parts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="desks-h">
        <div className="section-head">
          <p className="kicker">Try it</p>
          <h2 id="desks-h">Four desks, one escrow.</h2>
        </div>
        <nav className="desks" aria-label="Desks">
          {DESKS.map((d) => (
            <Link key={d.href} href={d.href} className="desk">
              <span className="desk-index">{d.index}</span>
              <span className="desk-name">{d.name}</span>
              <span className="desk-copy">
                <strong>{d.title}</strong>
                <span>{d.text}</span>
              </span>
              <span className="desk-go" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </nav>
      </section>

      <p className="fine">
        Testnet only. The lab, reviewer and compliance keys are demo custody, held by the server. Turning bUSD into rupees is simulated. Work content stays
        off-chain; only hashes, amounts and deadlines are public.
      </p>
    </div>
  );
}
