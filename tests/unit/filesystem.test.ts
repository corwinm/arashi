import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  DiskFullError,
  EncodingError,
  FilesystemError,
  InvalidPathError,
  NotFoundError,
  PermissionError,
  copyFile,
  ensureDir,
  fileExists,
  getWorktreePath,
  isExecutable,
  readTextFile,
  removeDir,
  writeTextFile,
} from "../../src/lib/filesystem";

// Test directory setup
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `filesystem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { force: true, recursive: true });
  }
});

describe("Filesystem Error Classes", () => {
  test("FilesystemError contains operation, path, and code", () => {
    const error = new FilesystemError("read", "/test/path", "ENOENT", "File not found");
    expect(error.operation).toBe("read");
    expect(error.path).toBe("/test/path");
    expect(error.code).toBe("ENOENT");
    expect(error.message).toBe("File not found");
    expect(error).toBeInstanceOf(Error);
  });

  test("PermissionError extends FilesystemError", () => {
    const error = new PermissionError("write", "/test/path", "EACCES", "Permission denied");
    expect(error).toBeInstanceOf(FilesystemError);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.code).toBe("EACCES");
  });

  test("NotFoundError extends FilesystemError", () => {
    const error = new NotFoundError("read", "/test/path", "ENOENT", "Not found");
    expect(error).toBeInstanceOf(FilesystemError);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("ENOENT");
  });

  test("DiskFullError extends FilesystemError", () => {
    const error = new DiskFullError("write", "/test/path", "ENOSPC", "No space");
    expect(error).toBeInstanceOf(FilesystemError);
    expect(error).toBeInstanceOf(DiskFullError);
    expect(error.code).toBe("ENOSPC");
  });

  test("InvalidPathError extends FilesystemError", () => {
    const error = new InvalidPathError("create", "/test/path", "EINVAL", "Invalid path");
    expect(error).toBeInstanceOf(FilesystemError);
    expect(error).toBeInstanceOf(InvalidPathError);
    expect(error.code).toBe("EINVAL");
  });

  test("EncodingError extends FilesystemError", () => {
    const error = new EncodingError("read", "/test/path", "ENCODING", "Not UTF-8");
    expect(error).toBeInstanceOf(FilesystemError);
    expect(error).toBeInstanceOf(EncodingError);
    expect(error.code).toBe("ENCODING");
  });
});

describe("US1: ensureDir - Safe Directory Operations", () => {
  test("creates directory and all parent directories", async () => {
    const dirPath = join(testDir, "parent", "child", "grandchild");
    await ensureDir(dirPath);

    expect(existsSync(dirPath)).toBe(true);
    expect(existsSync(join(testDir, "parent"))).toBe(true);
    expect(existsSync(join(testDir, "parent", "child"))).toBe(true);
  });

  test("succeeds if directory already exists (idempotent)", async () => {
    const dirPath = join(testDir, "existing");
    mkdirSync(dirPath);

    // Should not throw
    await ensureDir(dirPath);
    expect(existsSync(dirPath)).toBe(true);
  });

  test("throws PermissionError on insufficient permissions", async () => {
    // Create a directory without write permissions
    const parentDir = join(testDir, "readonly");
    mkdirSync(parentDir);
    chmodSync(parentDir, 0o444); // Read-only

    const dirPath = join(parentDir, "child");

    try {
      await expect(ensureDir(dirPath)).rejects.toThrow(PermissionError);
    } finally {
      // Cleanup: restore permissions
      chmodSync(parentDir, 0o755);
    }
  });

  test("handles absolute and relative paths", async () => {
    // Absolute path
    const absolutePath = join(testDir, "absolute");
    await ensureDir(absolutePath);
    expect(existsSync(absolutePath)).toBe(true);

    // Relative path (relative to testDir)
    const originalCwd = process.cwd();
    try {
      process.chdir(testDir);
      await ensureDir("./relative");
      expect(existsSync(join(testDir, "relative"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("US2: fileExists and isExecutable - File Existence and Permission Checks", () => {
  test("fileExists returns true for existing file", async () => {
    const filePath = join(testDir, "test.txt");
    writeFileSync(filePath, "content");

    expect(await fileExists(filePath)).toBe(true);
  });

  test("fileExists returns false for non-existent file", async () => {
    const filePath = join(testDir, "nonexistent.txt");
    expect(await fileExists(filePath)).toBe(false);
  });

  test("fileExists returns true for directories", async () => {
    const dirPath = join(testDir, "subdir");
    mkdirSync(dirPath);

    expect(await fileExists(dirPath)).toBe(true);
  });

  test("isExecutable returns true for executable file", async () => {
    const filePath = join(testDir, "executable.sh");
    writeFileSync(filePath, "#!/bin/bash\necho hello");

    if (process.platform !== "win32") {
      chmodSync(filePath, 0o755); // Make executable
      expect(await isExecutable(filePath)).toBe(true);
    } else {
      // On Windows, rename to .exe
      const exePath = join(testDir, "executable.exe");
      writeFileSync(exePath, "content");
      expect(await isExecutable(exePath)).toBe(true);
    }
  });

  test("isExecutable returns false for non-executable file", async () => {
    const filePath = join(testDir, "not-executable.txt");
    writeFileSync(filePath, "content");

    if (process.platform !== "win32") {
      chmodSync(filePath, 0o644); // Not executable
    }

    expect(await isExecutable(filePath)).toBe(false);
  });

  test("isExecutable handles Windows file extensions", async () => {
    if (process.platform === "win32") {
      const extensions = [".exe", ".bat", ".cmd", ".com"];

      for (const ext of extensions) {
        const filePath = join(testDir, `test${ext}`);
        writeFileSync(filePath, "content");
        expect(await isExecutable(filePath)).toBe(true);
      }
    }
  });
});

describe("US3: getWorktreePath - Worktree Path Calculation", () => {
  test("returns custom path if provided", () => {
    const result = getWorktreePath("/repos/project", "feature", false, "/custom/path");
    expect(result).toBe("/custom/path");
  });

  test("returns bare repository worktree path", () => {
    const result = getWorktreePath("/repos/bare.git", "feature", true);
    expect(result).toBe("/repos/bare.git/.git/worktrees/feature");
  });

  test("returns non-bare repository worktree path", () => {
    const result = getWorktreePath("/repos/project", "feature", false);
    expect(result).toBe("/repos/feature");
  });

  test("handles nested repository paths", () => {
    const result = getWorktreePath("/home/user/repos/project", "bugfix", false);
    expect(result).toBe("/home/user/repos/bugfix");
  });

  test("throws InvalidPathError for invalid repository path", () => {
    expect(() => getWorktreePath("", "feature", false)).toThrow(InvalidPathError);
  });
});

describe("US4: File I/O Operations - Read and Write Text Files", () => {
  test("readTextFile reads file contents as UTF-8", async () => {
    const filePath = join(testDir, "read-test.txt");
    const content = "Hello, World! 🌍";
    writeFileSync(filePath, content, "utf8");

    const result = await readTextFile(filePath);
    expect(result).toBe(content);
  });

  test("readTextFile throws NotFoundError for non-existent file", async () => {
    const filePath = join(testDir, "nonexistent.txt");
    await expect(readTextFile(filePath)).rejects.toThrow(NotFoundError);
  });

  test("writeTextFile writes content as UTF-8", async () => {
    const filePath = join(testDir, "write-test.txt");
    const content = "Test content with emoji 🚀";

    await writeTextFile(filePath, content);

    const result = await readTextFile(filePath);
    expect(result).toBe(content);
  });

  test("writeTextFile creates parent directories", async () => {
    const filePath = join(testDir, "nested", "dirs", "file.txt");
    const content = "nested content";

    await writeTextFile(filePath, content);

    expect(existsSync(filePath)).toBe(true);
    const result = await readTextFile(filePath);
    expect(result).toBe(content);
  });

  test("writeTextFile overwrites existing file", async () => {
    const filePath = join(testDir, "overwrite.txt");
    writeFileSync(filePath, "original");

    await writeTextFile(filePath, "updated");

    const result = await readTextFile(filePath);
    expect(result).toBe("updated");
  });

  test("copyFile copies file and preserves permissions", async () => {
    const srcPath = join(testDir, "source.txt");
    const destPath = join(testDir, "destination.txt");
    const content = "copy test content";

    writeFileSync(srcPath, content);
    if (process.platform !== "win32") {
      chmodSync(srcPath, 0o644);
    }

    await copyFile(srcPath, destPath);

    expect(existsSync(destPath)).toBe(true);
    const result = await readTextFile(destPath);
    expect(result).toBe(content);
  });

  test("copyFile throws NotFoundError if source doesn't exist", async () => {
    const srcPath = join(testDir, "nonexistent.txt");
    const destPath = join(testDir, "destination.txt");

    await expect(copyFile(srcPath, destPath)).rejects.toThrow(NotFoundError);
  });
});

describe("US5: Directory Cleanup Operations", () => {
  test("removeDir removes directory and all contents recursively", async () => {
    const dirPath = join(testDir, "remove-test");
    mkdirSync(dirPath);
    writeFileSync(join(dirPath, "file1.txt"), "content1");
    mkdirSync(join(dirPath, "subdir"));
    writeFileSync(join(dirPath, "subdir", "file2.txt"), "content2");

    await removeDir(dirPath);

    expect(existsSync(dirPath)).toBe(false);
  });

  test("removeDir succeeds if directory doesn't exist (idempotent)", async () => {
    const dirPath = join(testDir, "nonexistent");

    // Should not throw
    await removeDir(dirPath);
    expect(existsSync(dirPath)).toBe(false);
  });

  test("removeDir throws PermissionError on insufficient permissions", async () => {
    if (process.platform === "win32") {
      // Windows permission tests are complex, skip
      return;
    }

    const dirPath = join(testDir, "protected");
    mkdirSync(dirPath);
    const filePath = join(dirPath, "file.txt");
    writeFileSync(filePath, "content");

    // Make directory read-only
    chmodSync(dirPath, 0o444);

    try {
      await expect(removeDir(dirPath)).rejects.toThrow(PermissionError);
    } finally {
      // Cleanup
      chmodSync(dirPath, 0o755);
      rmSync(dirPath, { force: true, recursive: true });
    }
  });
});
