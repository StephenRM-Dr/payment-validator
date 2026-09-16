import type { MetadataRoute } from "next";

// PWA manifest: lets the teller (cajero) screen be "installed" from a phone browser
// (Add to Home Screen). Opens directly into the teller panel in standalone mode.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Payment Validator Cajero",
    short_name: "Payment Validator",
    description: "Teller panel — Binance Pay payment validation",
    start_url: "/cajero",
    display: "standalone",
    orientation: "portrait",
    background_color: "#11111b",
    theme_color: "#11111b",
  };
}
