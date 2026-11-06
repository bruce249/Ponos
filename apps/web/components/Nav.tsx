"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/lab", label: "Lab" },
  { href: "/work", label: "Work" },
  { href: "/review", label: "Review" },
  { href: "/transparency", label: "Ledger" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Desks">
      {LINKS.map((l) => {
        const on = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link key={l.href} href={l.href} className={on ? "on" : undefined} aria-current={on ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
