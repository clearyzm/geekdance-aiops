import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "极客跳动 AI 运营中心",
    template: "%s · 极客跳动 AI 运营中心",
  },
  description: "极客跳动内部 AI 内容生产、素材处理与渠道草稿管理平台",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
