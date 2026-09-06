import "./globals.css";
import type { Metadata, Viewport } from "next";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "Nexa Code AI",
  description: "Your autonomous AI coding workspace.",
  applicationName: "Nexa Code AI",
  appleWebApp: {
    capable: true,
    title: "Nexa Code AI",
    statusBarStyle: "black-translucent"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090b0f"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><PwaRegister />{children}</body></html>;
}
