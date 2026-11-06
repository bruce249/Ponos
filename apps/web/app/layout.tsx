import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { IBM_Plex_Sans, Newsreader } from "next/font/google";
import { Nav } from "@/components/Nav";
import "./globals.css";

const serif = Newsreader({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Ponos · Byline Work",
  description: "Escrowed bUSD payroll for people who train AI. A lab locks the pay before the work starts, and silence pays the freelancer.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <div className="shell">
          <aside className="rail">
            <Link className="wordmark" href="/">
              Ponos
              <span>Byline Work</span>
            </Link>
            <Nav />
            <p className="rail-foot">Escrowed bUSD payroll. The money is locked before the work starts.</p>
          </aside>
          <div className="stage">
            <header className="topbar">
              <Link className="wordmark" href="/">
                Ponos
              </Link>
              <Nav />
            </header>
            <main>{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
