import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  rewrites: async () => ({
    // beforeFiles rewrites run BEFORE Next.js API routes
    beforeFiles: [
      {
        source: "/api/:path*",
        destination: `${process.env.API_URL || "https://aislecrosser.example.railway.app"}/api/:path*`,
      },
    ],
    afterFiles: [],
    fallback: [],
  }),
};

export default nextConfig;
