import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nexa Code AI",
    short_name: "Nexa Code",
    description: "Your autonomous AI coding workspace.",
    start_url: "/",
    display: "standalone",
    background_color: "#090b0f",
    theme_color: "#090b0f",
    orientation: "any",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
