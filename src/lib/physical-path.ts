import { dirname, parse, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";

const traversesSymbolicLink = async (path: string): Promise<boolean> => {
  const { root } = parse(path);
  let current = path;
  while (current !== root) {
    if ((await lstat(current)).isSymbolicLink()) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return false;
};

const resolveUnaliasedPhysicalPath = async (input: string): Promise<string> => {
  const path = resolve(input);
  const physical = await realpath(path);
  // On Windows, inspect components no-follow because ordinary paths can have alternate spellings.
  const aliased =
    process.platform === "win32" ? await traversesSymbolicLink(path) : physical !== path;
  if (aliased) {
    throw new Error("Path traverses a symbolic link or physical alias.");
  }
  return physical;
};

export default resolveUnaliasedPhysicalPath;
