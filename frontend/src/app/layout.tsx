import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import Nav from "./nav";
import AuthGate from "./auth-gate";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const serif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "Reel Reviewer · FDP Final Review",
  description: "An AI reviewer that watches FDP reels - audio, video, captions and animation - and writes notes the way Nidhi would.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${serif.variable}`}>
      <body suppressHydrationWarning>
        <AuthGate>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark">N</div>
              <div>
                <div className="brand-name">Reel Reviewer</div>
                <div className="brand-sub">FDP final review</div>
              </div>
            </div>
            <Nav />
            <div className="sidebar-foot">
              <span className="dot-live" />Groq free tier
              <div className="faint" style={{ marginTop: 4 }}>Vision: qwen3.8-27b · Notes: gpt-oss-120b · Speech: whisper-v3</div>
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
        </AuthGate>
      </body>
    </html>
  );
}
