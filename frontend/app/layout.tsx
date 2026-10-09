import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MetricGround｜可信经营分析 Agent",
  description: "基于业务口径、查询证据和结果校验的可信经营分析工作台。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
