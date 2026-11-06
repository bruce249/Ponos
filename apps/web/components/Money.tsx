import { primaryHref, refLinks, type ChainRefs, type RefKind } from "@/lib/links";

export function Money({ amount, refs, prefer, className }: { amount: string; refs?: ChainRefs; prefer?: RefKind; className?: string }) {
  const cls = className === undefined ? "mono" : className;
  const href = refs ? primaryHref(refs, prefer) : null;
  if (!href) return <span className={cls}>{amount}</span>;
  return (
    <a className={cls} href={href} target="_blank" rel="noreferrer">
      {amount} ↗
    </a>
  );
}

export function RefLinks({ refs }: { refs: ChainRefs }) {
  const links = refLinks(refs);
  if (!links.length) return null;
  return (
    <div className="refs">
      {links.map((l) => (
        <a key={l.kind + l.href} href={l.href} target="_blank" rel="noreferrer" title={l.title}>
          {l.label} ↗
        </a>
      ))}
    </div>
  );
}
