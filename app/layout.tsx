import type { Metadata } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const sans = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trace PNG ke SVG",
  description:
    "Ubah PNG jadi SVG vektor langsung di browser. Atur warna dan detail, lalu unduh.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id" className={sans.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
