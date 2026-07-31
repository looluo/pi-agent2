import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ZipFile } from "yazl";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const sourcePiWeb = join(root, "pi-web");
const buildRoot = join(root, ".desktop-build");
const patchedPiWeb = join(buildRoot, "pi-web");
const bundleRoot = join(buildRoot, "runtime-bundle");
const resourcesDir = join(root, "src-tauri", "resources");
const runtimeZip = join(resourcesDir, "runtime-bundle.zip");
const nodeVersion = "v24.14.1";
const nodeArchive = `node-${nodeVersion}-win-x64.zip`;
const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchive}`;
const nodeZipPath = join(resourcesDir, nodeArchive);

function stage(message) {
  console.log(`\n[prepare:desktop] ${message}`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, cwd, env = {}) {
  const displayCwd = relative(root, cwd) || ".";
  console.log(`[prepare:desktop] $ ${command} ${args.join(" ")}  (cwd: ${displayCwd})`);
  await new Promise((resolve, reject) => {
    const useShell = process.platform === "win32" && (command === "npm" || command === "npx");
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: useShell,
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with ${code}`))));
    child.on("error", reject);
  });
}

async function replaceInFile(path, replacements) {
  let text = await readFile(path, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`Expected text not found in ${path}: ${from}`);
    text = text.split(from).join(to);
  }
  await writeFile(path, text, "utf8");
}

async function filteredCp(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).replaceAll("\\", "/");
      if (!rel) return true;
      if (rel === "node_modules" || rel.startsWith("node_modules/")) return false;
      if (rel === ".next" || rel.startsWith(".next/")) return false;
      return true;
    },
  });
}

async function copyForBundle(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).replaceAll("\\", "/");
      if (!rel) return true;
      if (rel === ".next/cache" || rel.startsWith(".next/cache/")) return false;
      if (rel === ".next/diagnostics" || rel.startsWith(".next/diagnostics/")) return false;
      if (rel.endsWith(".map")) return false;
      return true;
    },
  });
}

async function patchPiWeb() {
  stage("Patching temporary Pi Web copy for Pi Agent App branding");
  await replaceInFile(join(patchedPiWeb, "app", "layout.tsx"), [
    ['title: "Pi Web"', 'title: "Pi Agent App"'],
    ['description: "Pi Web interface for the pi coding agent"', 'description: "Pi Agent App interface for the pi coding agent"'],
    ['applicationName: "Pi Web"', 'applicationName: "Pi Agent App"'],
  ]);
  await replaceInFile(join(patchedPiWeb, "app", "manifest.ts"), [
    ['short_name: "Pi Web"', 'short_name: "Pi Agent App"'],
    ['name: "Pi Web"', 'name: "Pi Agent App"'],
  ]);
  await replaceInFile(join(patchedPiWeb, "components", "AppShell.tsx"), [
    ['`${activeCwdName} - Pi Web` : "Pi Web"', '`${activeCwdName} - Pi Agent App` : "Pi Agent App"'],
  ]);
  await replaceInFile(join(patchedPiWeb, "components", "ChatWindow.tsx"), [
    ['>Pi Web</span>', '>Pi Agent App</span>'],
  ]);

  const nextConfigPath = join(patchedPiWeb, "next.config.ts");
  let nextConfig = await readFile(nextConfigPath, "utf8");
  if (!nextConfig.includes('output: "standalone"')) {
    nextConfig = nextConfig.replace(
      "const nextConfig: NextConfig = {",
      'const nextConfig: NextConfig = {\n  output: "standalone",\n  generateBuildId: async () => "pi-agent-app",',
    );
    await writeFile(nextConfigPath, nextConfig, "utf8");
  }
}

async function downloadNode() {
  stage(`Ensuring ${nodeArchive}`);
  await mkdir(resourcesDir, { recursive: true });
  if (await pathExists(nodeZipPath)) {
    console.log(`[prepare:desktop] Reusing ${relative(root, nodeZipPath)}`);
    return;
  }
  console.log(`[prepare:desktop] Downloading ${nodeUrl}`);
  const response = await fetch(nodeUrl);
  if (!response.ok || !response.body) throw new Error(`Failed to download Node.js: ${response.status} ${response.statusText}`);
  await pipeline(response.body, createWriteStream(nodeZipPath));
}

async function patchInstalledNext() {
  // Next 16.2.12 currently calls generateBuildId even when config.generateBuildId is undefined/null.
  // Keep this patch inside the temporary build copy so the imported pi-web subtree remains unmodified.
  const generateBuildIdPath = join(patchedPiWeb, "node_modules", "next", "dist", "build", "generate-build-id.js");
  let text = await readFile(generateBuildIdPath, "utf8");
  const needle = "async function generateBuildId(generate, fallback) {\n";
  if (!text.includes(needle)) throw new Error(`Expected Next.js generateBuildId implementation not found in ${generateBuildIdPath}`);
  if (!text.includes("generate = async ()=>null;")) {
    text = text.replace(needle, `${needle}    if (typeof generate !== "function") generate = async ()=>null;\n`);
    await writeFile(generateBuildIdPath, text, "utf8");
  }
}

async function copyRuntimeOutput() {
  stage("Creating runtime bundle directory");
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(join(bundleRoot, "app"), { recursive: true });

  const standaloneDir = join(patchedPiWeb, ".next", "standalone");
  if (await pathExists(standaloneDir)) {
    console.log("[prepare:desktop] Using Next standalone output");
    await cp(standaloneDir, join(bundleRoot, "app"), { recursive: true });
    await copyRuntimeStatics();
  } else {
    console.log("[prepare:desktop] Next standalone directory was not emitted; bundling pruned production node_modules instead");
    await run("npm", ["prune", "--omit=dev", "--no-audit", "--fund=false", "--loglevel=warn"], patchedPiWeb);
    for (const entry of [".next", "node_modules", "package.json", "next.config.ts"]) {
      await copyForBundle(join(patchedPiWeb, entry), join(bundleRoot, "app", entry));
    }
    await writeFile(join(bundleRoot, "app", "server.js"), runtimeServerSource(), "utf8");
  }

  await copyRuntimeStatics();
  await mkdir(join(bundleRoot, "node"), { recursive: true });
  await cp(nodeZipPath, join(bundleRoot, "node", nodeArchive));
}

async function copyRuntimeStatics() {
  if (await pathExists(join(patchedPiWeb, ".next", "static"))) {
    await cp(join(patchedPiWeb, ".next", "static"), join(bundleRoot, "app", ".next", "static"), { recursive: true });
  }
  if (await pathExists(join(patchedPiWeb, "public"))) {
    await cp(join(patchedPiWeb, "public"), join(bundleRoot, "app", "public"), { recursive: true });
  }
}

function runtimeServerSource() {
  return `const http = require("node:http");\nconst next = require("next");\nconst port = Number(process.env.PORT || 30141);\nconst hostname = process.env.HOSTNAME || "127.0.0.1";\nconst app = next({ dev: false, dir: __dirname, hostname, port });\nconst handle = app.getRequestHandler();\napp.prepare().then(() => {\n  http.createServer((req, res) => handle(req, res)).listen(port, hostname, () => {\n    console.log("Pi Agent App server listening on http://" + hostname + ":" + port);\n  });\n}).catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n`;
}

async function addDirectoryToZip(zip, dir, base = dir, counter = { files: 0 }) {
  for (const entry of await readdir(dir)) {
    const abs = join(dir, entry);
    const rel = relative(base, abs).replaceAll("\\", "/");
    const s = await stat(abs);
    if (s.isDirectory()) {
      await addDirectoryToZip(zip, abs, base, counter);
    } else if (s.isFile()) {
      zip.addFile(abs, rel);
      counter.files += 1;
      if (counter.files % 5000 === 0) console.log(`[prepare:desktop] queued ${counter.files} files for runtime zip...`);
    }
  }
  return counter.files;
}

async function zipRuntimeBundle() {
  stage("Writing src-tauri/resources/runtime-bundle.zip");
  await mkdir(resourcesDir, { recursive: true });
  await new Promise(async (resolve, reject) => {
    const zip = new ZipFile();
    zip.outputStream.pipe(createWriteStream(runtimeZip)).on("close", resolve).on("error", reject);
    try {
      const files = await addDirectoryToZip(zip, bundleRoot);
      console.log(`[prepare:desktop] queued ${files} total files; compressing...`);
      zip.end();
    } catch (error) {
      reject(error);
    }
  });
  const data = await readFile(runtimeZip);
  console.log(`[prepare:desktop] Wrote ${relative(root, runtimeZip)} (${(data.length / 1024 / 1024).toFixed(1)} MiB, sha256 ${createHash("sha256").update(data).digest("hex")})`);
}

stage("Resetting temporary build directory");
await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await filteredCp(sourcePiWeb, patchedPiWeb);
await patchPiWeb();
await downloadNode();
stage("Installing Pi Web dependencies");
await run("npm", ["install", "--include=dev", "--no-audit", "--fund=false", "--loglevel=warn"], patchedPiWeb);
await patchInstalledNext();
const safeHome = join(buildRoot, "home");
await mkdir(safeHome, { recursive: true });
stage("Building temporary Pi Web copy");
await run(process.execPath, [join(patchedPiWeb, "node_modules", "next", "dist", "bin", "next"), "build", "--webpack"], patchedPiWeb, {
  NEXT_TELEMETRY_DISABLED: "1",
  __NEXT_SHOW_IGNORE_LISTED: "true",
  HOME: safeHome,
  USERPROFILE: safeHome,
  APPDATA: join(safeHome, "AppData", "Roaming"),
  LOCALAPPDATA: join(safeHome, "AppData", "Local"),
});
await copyRuntimeOutput();
await zipRuntimeBundle();
