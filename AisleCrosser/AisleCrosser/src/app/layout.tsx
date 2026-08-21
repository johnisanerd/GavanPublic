import type { Metadata } from "next";
import { Noto_Serif, Public_Sans } from "next/font/google";
import { Header } from "@/components/layout/header";
import "./globals.css";

const notoSerif = Noto_Serif({
  variable: "--font-noto-serif",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Aisle Crosser — Bipartisan Strategy Platform",
  description: "AI-powered tool for finding cross-party collaboration opportunities in Congress",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${notoSerif.variable} ${publicSans.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col overflow-hidden bg-surface text-ink">
        <Header />
        <main className="flex-1 min-h-0">{children}</main>
      </body>
    </html>
  );
}
