// Build-time step: copy the device installer (packages/device/install.sh) into
// apps/dashboard/public/install.sh so the dashboard — the public web origin
// — serves it statically at GET /install.sh.
//
// This is what the Integrations page's one-liner points at:
//   curl -fsSL ${NEXT_PUBLIC_APP_URL}/install.sh | TOKEN=<pairing-token> sh
//
// We copy rather than symlink so it survives Vercel's build and the standalone
// Docker image (Next copies `public/` into both). Runs from the `prebuild` npm
// lifecycle hook and is also chained into `build` for environments that skip
// lifecycle scripts.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "..");
const src = resolve(dashboardRoot, "../../packages/device/install.sh");
const destDir = resolve(dashboardRoot, "public");
const dest = resolve(destDir, "install.sh");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

console.log(`[copy-install-script] ${src} -> ${dest}`);
