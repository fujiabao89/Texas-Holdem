import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "../components/app-providers";
import { message } from "../messages/zh-CN";
import { SiteChrome } from "../components/site-chrome";
import "./globals.css";

export const metadata: Metadata = {
  title: message("app.title"),
  description: message("app.description"),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body><AppProviders><SiteChrome>{children}</SiteChrome></AppProviders></body>
    </html>
  );
}
