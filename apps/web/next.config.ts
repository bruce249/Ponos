import path from "node:path";
import type { NextConfig } from "next";

// One .env for the whole repo, same pattern as Byline v2.
const root = path.resolve(process.cwd(), "../..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* no .env: rely on the real environment */
}

const API_URL = (process.env.API_URL || "http://localhost:8787").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  transpilePackages: ["@byline-work/shared"],
  turbopack: { root },
  outputFileTracingRoot: root,
  // The browser talks to one origin. /api and /x402 are proxied to the Hono API,
  // so the World session cookie stays on localhost:3000.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/x402/:path*", destination: `${API_URL}/x402/:path*` },
    ];
  },
};

export default nextConfig;
