import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { discoverLifecycleHookCandidates, resolveLifecycleHookFilePath } from "./hooks.ts";
import type { RepositoryActivePathObserver } from "./repository-config-editor.ts";

const pathMetadata = async (path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** Observe only filesystem metadata; never read hook file contents. */
export const observeRepositoryActivePaths = (options: {
  activeConfigRoot: string;
  activeRepositoryPath: string;
  platform?: NodeJS.Platform;
  repositoryScopedCreate?: boolean;
}): RepositoryActivePathObserver => {
  const platform = options.platform ?? process.platform;
  return async (request) =>
    Promise.all(
      request.lifecycles.map(async ({ lifecycle, plannedPath }) => {
        const create = lifecycle === "pre-create" || lifecycle === "post-create";
        const ownerRoot = create ? options.activeConfigRoot : options.activeRepositoryPath;
        const hookName =
          create && options.repositoryScopedCreate !== false
            ? `${lifecycle}.${request.repositoryName}`
            : lifecycle;
        const destination =
          plannedPath ?? resolveLifecycleHookFilePath({ hookName, ownerRoot, platform });
        const destinationMetadata = await pathMetadata(destination);
        let cursor = dirname(destination);
        let symlinkParent = false;
        let unsafeDestination = Boolean(
          destinationMetadata &&
          (destinationMetadata.isSymbolicLink() || !destinationMetadata.isFile()),
        );
        for (;;) {
          const metadata = await pathMetadata(cursor);
          if (metadata) {
            symlinkParent ||= metadata.isSymbolicLink();
            unsafeDestination ||= !metadata.isDirectory() || metadata.isSymbolicLink();
          }
          if (cursor === ownerRoot || dirname(cursor) === cursor) break;
          cursor = dirname(cursor);
        }
        const nativeCandidates = await discoverLifecycleHookCandidates(
          hookName,
          ownerRoot,
          platform,
        );
        return {
          destinationExists: destinationMetadata !== null,
          lifecycle,
          nativeCandidateCount: nativeCandidates.length,
          symlinkParent,
          unsafeDestination,
        };
      }),
    );
};
