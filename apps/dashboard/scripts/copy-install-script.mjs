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
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "..");
const deviceDir = resolve(dashboardRoot, "../../packages/device");
const sharedDir = resolve(dashboardRoot, "../../packages/shared");
const src = resolve(deviceDir, "install.sh");
const destDir = resolve(dashboardRoot, "public");
const dest = resolve(destDir, "install.sh");
const tarball = resolve(destDir, "imsg-device.tar.gz");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-install-script] ${src} -> ${dest}`);

// Pack the plugin into a SELF-CONTAINED tarball. The plugin depends on the
// workspace package @imsg/shared, which a standalone `bun install` (run by the
// piped installer outside the monorepo) cannot resolve via `workspace:*`. So we
// vendor @imsg/shared into the tarball under vendor/shared and rewrite the dep
// to a local `file:` path. `bun install` then links it locally and still fetches
// the real npm deps (zod, @modelcontextprotocol/sdk) from the registry.
const EXCLUDE = new Set(["node_modules", "logs", ".token"]);
const keep = (srcPath) => !EXCLUDE.has(basename(srcPath));

const staging = mkdtempSync(join(tmpdir(), "imsg-device-pkg-"));
try {
  // Device plugin at the archive root...
  cpSync(deviceDir, staging, { recursive: true, filter: keep });
  // ...with @imsg/shared vendored alongside it.
  cpSync(sharedDir, join(staging, "vendor", "shared"), {
    recursive: true,
    filter: keep,
  });

  // Rewrite workspace:* -> file: so the dep resolves outside the monorepo.
  const pkgPath = join(staging, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies["@imsg/shared"] = "file:./vendor/shared";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // `-C staging .` roots the archive at the staging dir, so extracting yields
  // ./.claude-plugin/plugin.json + ./vendor/shared — what install.sh expects.
  execFileSync("tar", ["-czf", tarball, "-C", staging, "."], {
    stdio: ["ignore", "inherit", "inherit"],
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`[copy-install-script] packaged ${deviceDir} (+@imsg/shared) -> ${tarball}`);
