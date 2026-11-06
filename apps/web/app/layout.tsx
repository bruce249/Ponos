import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import "./globals.css";

const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Byline Work",
  description: "The money is locked before the work starts, and silence pays the freelancer. Escrowed payroll for people who train AI.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <header className="mast">
          <div className="wrap">
            <a className="brand" href="/">
              <b>Byline Work</b>
              <span>silence pays the freelancer</span>
            </a>
            <Nav />
          </div>
        </header>
        <main>
          <div className="wrap">{children}</div>
        </main>
      </body>
    </html>
  );
}
