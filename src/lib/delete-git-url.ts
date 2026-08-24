import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec as gitExec } from "./git.ts";
import { realpath } from "node:fs/promises";

export class GitFetchUrlIdentityError extends Error {
  readonly reason: "mismatch" | "unavailable";

  constructor(message: string, reason: "mismatch" | "unavailable" = "unavailable") {
    super(`Invalid Git fetch URL identity: ${message}`);
    this.name = "GitFetchUrlIdentityError";
    this.reason = reason;
  }
}

const urlError = (
  message: string,
  reason: "mismatch" | "unavailable" = "unavailable",
): GitFetchUrlIdentityError => new GitFetchUrlIdentityError(message, reason);

const stripRepositorySuffix = (path: string): string => {
  let normalized = path.replace(/\/+$/u, "");
  if (normalized.toLowerCase().endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  return normalized.replace(/\/+$/u, "") || "/";
};

const rewrittenUrl = async (input: string, cwd: string): Promise<string> => {
  if (!input || input.includes("\0") || input.trim() !== input) {
    throw urlError("URL is malformed");
  }
  const output = (await gitExec(["ls-remote", "--get-url", input], cwd)).stdout;
  const lines = output.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0]) {
    throw urlError("URL rewrite result is malformed");
  }
  return lines[0];
};

const parseUrl = (input: string): URL => {
  try {
    return new URL(input);
  } catch {
    throw urlError("URL is malformed");
  }
};

export const canonicalizeGitFetchUrl = async (input: string, cwd: string): Promise<string> => {
  const rewritten = await rewrittenUrl(input, cwd);
  const hasHierarchicalScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(rewritten);
  const scp = hasHierarchicalScheme ? null : /^(?:([^@/:]+)@)?([^/:]+):(.+)$/u.exec(rewritten);
  if (scp && !isAbsolute(rewritten)) {
    const [, user = "", host, path] = scp;
    if (!host || !path || /[\s?#]/u.test(host)) {
      throw urlError("SCP URL is malformed");
    }
    return `ssh://${user ? `${user}@` : ""}${host.toLowerCase()}/${stripRepositorySuffix(path)}`;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rewritten)) {
    const parsed = parseUrl(rewritten);
    if (parsed.protocol === "file:") {
      let filePath = "";
      try {
        filePath = fileURLToPath(parsed);
      } catch {
        throw urlError("file URL is malformed");
      }
      return `file:${stripRepositorySuffix(await realpath(filePath))}`;
    }
    if (!parsed.hostname || parsed.password || parsed.search || parsed.hash) {
      throw urlError("URL is malformed");
    }
    const scheme = parsed.protocol.toLowerCase();
    const user = parsed.username ? `${decodeURIComponent(parsed.username)}@` : "";
    const port = parsed.port ? `:${parsed.port}` : "";
    const path = stripRepositorySuffix(decodeURIComponent(parsed.pathname));
    if (path === "/") {
      throw urlError("URL repository path is unavailable");
    }
    return `${scheme}//${user}${parsed.hostname.toLowerCase()}${port}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  const localPath = resolve(cwd, rewritten);
  return `file:${stripRepositorySuffix(await realpath(localPath))}`;
};

export const gitFetchUrlsMatch = async (input: {
  configuredUrl: string;
  fetchUrls: readonly string[];
  configuredCwd: string;
  fetchCwd?: string;
}): Promise<true> => {
  if (input.fetchUrls.length === 0) {
    throw urlError("no fetch URLs are configured");
  }
  const fetchCwd = input.fetchCwd ?? input.configuredCwd;
  const configured = await canonicalizeGitFetchUrl(input.configuredUrl, input.configuredCwd);
  const stored = await Promise.all(
    input.fetchUrls.map((url) => canonicalizeGitFetchUrl(url, fetchCwd)),
  );
  if (!stored.includes(configured)) {
    throw urlError("no fetch URL matches the configured URL", "mismatch");
  }
  return true;
};
