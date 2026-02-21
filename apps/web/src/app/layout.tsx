import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { Providers } from "@/app/providers";
import { ClientGuard } from "@/app/client-guard";
import "@/app/globals.css";

const sans = Manrope({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "700"] });

export const metadata: Metadata = {
  title: "Brain Dock UI",
  description: "Personal life OS UI (local-first)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className={`${sans.variable} ${mono.variable} font-sans text-ink`}>
        <Providers>
          <ClientGuard />
          <main>
            <header className="sticky top-0 z-40 border-b border-white/30 bg-cream/80 backdrop-blur">
              <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
                <Link href="/" className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wider">
                  <Image src="/icon.png" alt="Brain Dock icon" width={20} height={20} className="rounded-sm" />
                  <span>Brain Dock</span>
                </Link>
                <nav className="flex items-center gap-3 text-sm">
                  <Link href="/insights" className="hover:underline">分析</Link>
                  <Link href="/sync" className="hover:underline">同期</Link>
                  <Link href="/lock" className="hover:underline">ロック</Link>
                </nav>
              </div>
            </header>
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
