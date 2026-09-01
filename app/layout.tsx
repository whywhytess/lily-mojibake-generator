import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "ETHER｜乱码影像字幕生成器";
  const description = "上传视频，生成《关于莉莉周的一切》气质的乱码中央字幕与转场。";
  return {
    title,
    description,
    icons: { icon: "/apple-icon.png", shortcut: "/apple-icon.png", apple: "/apple-icon.png" },
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1670, height: 938, alt: "ETHER 乱码影像字幕生成器" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={geistMono.variable}>{children}</body>
    </html>
  );
}
