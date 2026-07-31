import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const exe = join(root, "src-tauri", "target", "release", "pi-agent.exe");
const out = join(root, "dist", "pi-agent.exe");

await stat(exe);
await mkdir(join(root, "dist"), { recursive: true });
await copyFile(exe, out);
console.log(`Copied ${out}`);
