"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Pitch" },
  { href: "/lab", label: "Lab" },
  { href: "/work", label: "Work" },
  { href: "/review", label: "Review" },
  { href: "/transparency", label: "Transparency" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={l.href === "/" ? (path === "/" ? "on" : "") : path.startsWith(l.href) ? "on" : ""}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
