import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/capture",
        destination: "/",
        permanent: false,
      },
      {
        source: "/capture/:path*",
        destination: "/",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
