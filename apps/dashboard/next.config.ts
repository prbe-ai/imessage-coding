import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained build (`.next/standalone/`) for the Docker image that
  // serves message.prbe.ai. Ignored by Vercel, which packages its own way.
  output: "standalone",

  // `@imsg/shared` is a workspace package shipped as TypeScript source
  // (no dist). Transpile it through the Next build pipeline so its `.ts`
  // entrypoint is compiled like first-party app code.
  transpilePackages: ["@imsg/shared"],
};

export default nextConfig;
