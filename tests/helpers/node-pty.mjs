import { createRequire } from "node:module";
import * as pty from "node-pty";
import { ensureDarwinSpawnHelperExecutable } from "./node-pty-permissions.mjs";

ensureDarwinSpawnHelperExecutable(createRequire(import.meta.url));

export const spawnPty = pty.spawn;
