import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use Turbopack (default in Next.js 16)
  turbopack: {
    root: ".",
  },
  // Handle external images from ordfs
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ordfs.network",
      },
    ],
  },
};

export default nextConfig;
