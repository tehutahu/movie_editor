import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Movie Editor — ローカルMVP",
  description:
    "倍速動画を元の速度・音程へ戻し、区間の書き出し・削除結合まで行えるローカル用Webツールです。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
