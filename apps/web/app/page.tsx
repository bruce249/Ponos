import Link from "next/link";

const DESKS = [
  {
    href: "/lab",
    kicker: "Lab",
    title: "Fund the batch",
    text: "Post the work, the pay, and the rubric. The escrow locks the money before anyone can claim a task.",
  },
  {
    href: "/work",
    kicker: "Work",
    title: "Claim and submit",
    text: "World ID, a payout account, and a live countdown. If nobody reviews in time, the scheduled release pays you.",
  },
  {
    href: "/review",
    kicker: "Review",
    title: "Approve, hold, or split",
    text: "Over $100 a reviewer decides. A hold needs a reason. Doing nothing does not stop the deadline.",
  },
  {
    href: "/transparency",
    kicker: "Transparency",
    title: "Reserve, NAV, and the log",
    text: "Supply, value locked, the live HCS task log, and the contributor score. Every figure links to HashScan.",
  },
];

export default function HomePage() {
  return (
    <>
      <div className="kicker">Escrowed payroll for people who train AI</div>
      <h1>The money is locked before the work starts, and silence pays the freelancer.</h1>
      <p className="lede">
        An AI lab funds a batch in bUSD. The pay sits in an escrow on Hedera before a freelancer in Pune, or anywhere else, claims the task. Submit the work and a
        scheduled transaction is armed. If QA and the reviewer stay quiet, that schedule pays the freelancer.
      </p>

      <div className="grid2" style={{ marginTop: 28 }}>
        {DESKS.map((d) => (
          <Link key={d.href} href={d.href} className="card home-card">
            <div className="kicker">{d.kicker}</div>
            <h2>{d.title}</h2>
            <p className="sub">{d.text}</p>
          </Link>
        ))}
      </div>

      <div className="card" style={{ marginTop: 22 }}>
        <h2>How a task gets paid</h2>
        <ol className="steps">
          <li>
            <span className="s">1</span>
            <span>The lab locks pay plus the fee. Nothing can be claimed until the batch is funded.</span>
          </li>
          <li>
            <span className="s">2</span>
            <span>A World ID freelancer binds a payout account, claims, and submits. The review deadline is public.</span>
          </li>
          <li>
            <span className="s">3</span>
            <span>$100 or less can pay the moment QA passes. Over $100, a reviewer approves or holds with a reason.</span>
          </li>
          <li>
            <span className="s">4</span>
            <span>If the deadline passes with no decision, the schedule releases the pay. The freelancer holds bUSD, and the page shows the rupee value.</span>
          </li>
        </ol>
      </div>

      <p className="foot-note">
        Testnet demo. The lab key and the freeze key are demo custody. Redeeming to rupees is simulated. Work stays off-chain. HashScan shows the hashes, the
        amounts, and the deadlines.
      </p>
    </>
  );
}
