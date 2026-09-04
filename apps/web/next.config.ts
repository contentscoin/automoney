import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@automoney/shared"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
};

export default nextConfig;
