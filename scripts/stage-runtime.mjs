import { chmod, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "target", "release", "kodegpt-runtime");
const destination = join(root, "packages", "runtime-linux-x64", "bin", "kodegpt-runtime");
const tmpDestination = `${destination}.tmp`;
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, tmpDestination);
await chmod(tmpDestination, 0o755);
await rename(tmpDestination, destination);
