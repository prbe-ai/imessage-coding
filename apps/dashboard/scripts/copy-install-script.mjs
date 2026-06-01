// Build-time step: publish the device plugin so the dashboard — the public web
// origin — serves it statically. Two artifacts land in apps/dashboard/public:
//
//   install.sh            GET /install.sh         — the installer script
//   imsg-device.tar.gz    GET /imsg-device.tar.gz — the plugin code itself
//
// This is what the Integrations page's one-liner points at:
//   curl -fsSL ${NEXT_PUBLIC_APP_URL}/install.sh \
//     | IMSG_INSTALL_BASE=${NEXT_PUBLIC_APP_URL} IMSG_CONTROL_PLANE_URL=… TOKEN=… sh
//
// A piped `curl | sh` only downloads the SCRIPT, never the plugin source — so the
// installer fetches imsg-device.tar.gz from IMSG_INSTALL_BASE and unpacks it. We
// must therefore ship the tarball, not just the script.
//
// We copy/build into public/ rather than symlink so it survives Vercel's build
// and the standalone Docker image (Next copies `public/` into both). Runs from
// the `prebuild` npm lifecycle hook and is also chained into `build` for
// environments that skip lifecycle scripts. The tarball is gitignored — it is a
// build artifact regenerated here on every build.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "..");
const deviceDir = resolve(dashboardRoot, "../../packages/device");
const src = resolve(deviceDir, "install.sh");
const destDir = resolve(dashboardRoot, "public");
const dest = resolve(destDir, "install.sh");
const tarball = resolve(destDir, "imsg-device.tar.gz");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-install-script] ${src} -> ${dest}`);

// Pack the plugin source (same exclusions the installer's own staging tar uses).
// `-C deviceDir .` roots the archive at the plugin dir, so extracting yields
// ./.claude-plugin/plugin.json — exactly what install.sh expects under $SRC.
execFileSync(
  "tar",
  [
    "-czf",
    tarball,
    "-C",
    deviceDir,
    "--exclude=node_modules",
    "--exclude=logs",
    "--exclude=.token",
    ".",
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
console.log(`[copy-install-script] packaged ${deviceDir} -> ${tarball}`);
