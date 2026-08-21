import { DM_Sans, DM_Mono } from "next/font/google";
import "./globals.css";

// Brand typefaces (§ 2). DM Sans = display + body; DM Mono = metadata strip.
const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-dm-sans",
});
const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-dm-mono",
});

export const metadata = {
  title: "The Test",
  description: "The Test",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${dmSans.variable} ${dmMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
