import Link from "next/link";

const DESKS = [
  {
    href: "/lab",
    index: "01",
    name: "Lab",
    title: "Fund the batch",
    text: "Post the work, the pay, and the rubric. The escrow locks the money before anyone can claim a task.",
  },
  {
    href: "/work",
    index: "02",
    name: "Work",
    title: "Claim and submit",
    text: "World ID, a payout account, and a live countdown. If nobody reviews in time, the scheduled release pays you.",
  },
  {
    href: "/review",
    index: "03",
    name: "Review",
    title: "Approve, hold, or split",
    text: "Over $100 a reviewer decides. A hold needs a reason. Doing nothing does not stop the deadline.",
  },
  {
    href: "/transparency",
    index: "04",
    name: "Ledger",
    title: "Reserve, NAV, and the log",
    text: "Supply, value locked, the live HCS task log, and the contributor score. Every figure links to HashScan.",
  },
];

export default function HomePage() {
  return (
    <div className="home">
      <p className="sentence">Escrowed bUSD payroll for people who train AI: a lab locks the pay before the work starts, and silence pays the freelancer.</p>
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
    </div>
  );
}
