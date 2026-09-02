import { pathToFileURL } from "node:url";

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const isExactVersion = (version) => exactVersionPattern.test(version);

class GitHubApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const notificationMarker = (version) => `<!-- arashi-release:${version} -->`;

export function extractClosingReferences(text, owner, repo) {
  if (!text) {
    return [];
  }
  const slug = `${escapeRegExp(owner)}/${escapeRegExp(repo)}`;
  const reference = `(?:https://github\\.com/${slug}/(?:issues|pull)/(\\d+)|${slug}#(\\d+)|#(\\d+))`;
  const pattern = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+${reference}`, "gi");
  const numbers = new Set();
  for (const match of text.matchAll(pattern)) {
    numbers.add(Number(match[1] ?? match[2] ?? match[3]));
  }
  return [...numbers];
}

function createRequest(token) {
  return async (path, options = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: options.method ?? "GET",
    });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `${response.status} ${response.statusText}: ${path}`,
      );
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  };
}

export async function notifyTarget({ number, owner, releaseUrl, repo, request, version }) {
  try {
    const issue = await request(`/repos/${owner}/${repo}/issues/${number}`);
    const marker = notificationMarker(version);
    let commentExists = false;
    for (let page = 1; !commentExists; page += 1) {
      const comments = await request(
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      commentExists = comments.some(
        (comment) =>
          comment.user?.login === "github-actions[bot]" && comment.body?.includes(marker),
      );
      if (comments.length < 100) {
        break;
      }
    }

    const kind = issue.pull_request ? "pull request" : "issue";
    if (!commentExists) {
      await request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        body: {
          body: `${marker}\n🎉 This ${kind} is included in [version ${version}](${releaseUrl}).`,
        },
        method: "POST",
      });
    }
    await request(`/repos/${owner}/${repo}/issues/${number}/labels`, {
      body: { labels: ["released"] },
      method: "POST",
    });
    return commentExists ? "existing" : "notified";
  } catch (error) {
    if (error?.status === 404) {
      return "missing";
    }
    throw error;
  }
}

export async function releaseCommits({ currentTag, owner, repo, request }) {
  const releases = await request(`/repos/${owner}/${repo}/releases?per_page=100`);
  const currentIndex = releases.findIndex((release) => release.tag_name === currentTag);
  if (currentIndex === -1) {
    throw new Error(`GitHub release ${currentTag} was not found`);
  }
  const previous = releases
    .slice(currentIndex + 1)
    .find(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name),
    );
  if (!previous) {
    return {
      commits: [await request(`/repos/${owner}/${repo}/commits/${currentTag}`)],
      releaseUrl: releases[currentIndex].html_url,
    };
  }
  const commits = [];
  let totalCommits = Number.POSITIVE_INFINITY;
  for (let page = 1; commits.length < totalCommits; page += 1) {
    const comparison = await request(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(previous.tag_name)}...${encodeURIComponent(currentTag)}?per_page=100&page=${page}`,
    );
    totalCommits = comparison.total_commits;
    commits.push(...comparison.commits);
    if (comparison.commits.length === 0) {
      break;
    }
  }
  return { commits, releaseUrl: releases[currentIndex].html_url };
}

export async function notifyPublishedRelease({ owner, repo, request, version }) {
  const currentTag = `v${version}`;
  const { commits, releaseUrl } = await releaseCommits({ currentTag, owner, repo, request });
  const targets = new Set();

  for (const commit of commits) {
    for (const number of extractClosingReferences(commit.commit?.message, owner, repo)) {
      targets.add(number);
    }
    const pulls = await request(`/repos/${owner}/${repo}/commits/${commit.sha}/pulls?per_page=100`);
    for (const pull of pulls) {
      targets.add(pull.number);
      for (const number of extractClosingReferences(pull.body, owner, repo)) {
        targets.add(number);
      }
    }
  }

  let notified = 0;
  let existing = 0;
  let missing = 0;
  const errors = [];
  for (const number of [...targets].toSorted((left, right) => left - right)) {
    try {
      const result = await notifyTarget({ number, owner, releaseUrl, repo, request, version });
      if (result === "notified") {
        notified += 1;
      }
      if (result === "existing") {
        existing += 1;
      }
      if (result === "missing") {
        missing += 1;
      }
    } catch (error) {
      errors.push(`#${number}: ${error.message}`);
    }
  }

  console.log(
    `Release notifications: ${notified} added, ${existing} existing, ${missing} missing.`,
  );
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

async function main() {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version || !isExactVersion(version)) {
    throw new Error("An exact release version is required");
  }
  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!token || !owner || !repo) {
    throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  }
  await notifyPublishedRelease({ owner, repo, request: createRequest(token), version });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
