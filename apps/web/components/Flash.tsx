import { RefLinks } from "@/components/Money";
import type { ChainRefs } from "@/lib/links";

export type FlashNote = {
  kind: "good" | "bad" | "info" | "warn";
  title: string;
  text?: string;
  refs?: ChainRefs;
};

export function Flash({ flash }: { flash: FlashNote | null }) {
  if (!flash) return null;
  return (
    <div className={`notice ${flash.kind}`} style={{ marginTop: 16 }}>
      <b>{flash.title}</b>
      {flash.text ? <span>{flash.text}</span> : null}
      {flash.refs ? <RefLinks refs={flash.refs} /> : null}
    </div>
  );
}
