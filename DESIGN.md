# Arashi Design Document

> "The eye of the storm for your development workflow"

## Overview

Arashi is a Git worktree manager for meta-repositories that automatically manages worktrees across multiple related repositories. When working with projects that require coordination between multiple repositories, Arashi simplifies the workflow by ensuring all related repositories maintain synchronized worktrees.

## Core Concept

### The Problem
When working on features that span multiple repositories, developers typically:
- Manually create worktrees in each repository
- Track which branches correspond to which features
- Remember to clean up worktrees and branches across all repositories
- Set up development environments in each worktree

### The Solution
Arashi automates this entire workflow by:
- Creating coordinated worktrees across a main repository and all sub-repositories
- Automatically handling branch creation and synchronization
- Providing centralized cleanup and status checking
- Running setup scripts to prepare development environments

## Architecture

### Project Structure

```
my-metarepo/                    # Main git repository
├── .git/
├── .gitignore                  # Contains "repos/"
├── .arashi/                    # Arashi configuration
│   ├── config.json             # Repository configuration
│   └── hooks/                  # Lifecycle hooks
│       ├── pre-create.sh
│       ├── post-create.sh
│       └── setup.sh
├── repos/                      # Gitignored folder containing sub-repos
│   ├── frontend/               # Git repo 1
│   ├── backend/                # Git repo 2
│   └── shared-lib/             # Git repo 3
├── src/                        # Main repo code
└── README.md

# When you create a worktree:
../my-metarepo-feature-foo/     # Worktree directory (sibling to main)
├── .git                        # Git worktree metadata
├── .arashi/                    # Configuration
├── repos/
│   ├── frontend/               # Worktree of frontend on feature-foo
│   ├── backend/                # Worktree of backend on feature-foo
│   └── shared-lib/             # Worktree of shared-lib on feature-foo
├── src/
└── README.md

# Or for bare repositories:
my-bare-repo.git/               # Bare repository
├── branches/
├── config
├── description
├── HEAD
├── hooks/
├── info/
├── objects/
├── refs/
├── .arashi/
├── main/                       # Worktree for main branch
│   ├── repos/
│   └── src/
└── feature-foo/                # Worktree for feature-foo
    ├── repos/
    └── src/
```

### Configuration Schema

```json
{
  "version": "1.0.0",
  "repos_dir": "repos",
  "worktree_strategy": "same_branch",
  "auto_setup": true,
  "discovered_repos": {
    "frontend": {
      "path": "repos/frontend",
      "default_branch": "main",
      "remote": "origin",
      "has_setup_script": true,
      "git_url": "git@github.com:user/frontend.git"
    },
    "backend": {
      "path": "repos/backend",
      "default_branch": "master",
      "remote": "origin",
      "has_setup_script": false,
      "git_url": "git@github.com:user/backend.git"
    }
  }
}
```

## Feature Roadmap

### Phase 1: Foundation ✅

#### Task 1.1: Project Setup ✅
- [x] Install Bun runtime
- [x] Create project structure
- [x] Set up package.json with dependencies
- [x] Configure TypeScript
- [x] Create type definitions

#### Task 1.2: Utility Libraries
**Status:** Not Started  
**Files:** `src/lib/git.ts`, `src/lib/config.ts`, `src/lib/filesystem.ts`, `src/lib/logger.ts`, `src/lib/prompts.ts`

**Implementation Details:**
- **git.ts**: Wrapper functions for git commands
  - `isGitBareRepo(path: string): Promise<boolean>`
  - `createWorktree(path: string, branch: string, location: string): Promise<void>`
  - `removeWorktree(path: string): Promise<void>`
  - `listWorktrees(repoPath: string): Promise<WorktreeInfo[]>`
  - `branchExists(repoPath: string, branch: string): Promise<boolean>`
  - `createBranch(repoPath: string, branch: string, fromBranch: string): Promise<void>`
  - `deleteBranch(repoPath: string, branch: string, force?: boolean): Promise<void>`
  - `fetchLatest(repoPath: string, remote?: string): Promise<void>`
  - `setUpstreamTracking(repoPath: string, branch: string, remote: string): Promise<void>`
  - `getStatus(repoPath: string): Promise<'clean' | 'dirty' | 'error'>`
  - `getDefaultBranch(repoPath: string): Promise<string>`
  - `getCurrentBranch(repoPath: string): Promise<string>`

- **config.ts**: Configuration file management
  - `loadConfig(repoPath: string): Promise<ArashiConfig>`
  - `saveConfig(repoPath: string, config: ArashiConfig): Promise<void>`
  - `addRepo(config: ArashiConfig, repoName: string, repoConfig: RepoConfig): ArashiConfig`
  - `removeRepo(config: ArashiConfig, repoName: string): ArashiConfig`
  - `getConfigPath(repoPath: string): string`
  - `configExists(repoPath: string): Promise<boolean>`

- **filesystem.ts**: File system operations
  - `ensureDir(path: string): Promise<void>`
  - `fileExists(path: string): Promise<boolean>`
  - `isExecutable(path: string): Promise<boolean>`
  - `getWorktreePath(repoPath: string, branch: string, isBare: boolean, customPath?: string): string`
  - `copyFile(src: string, dest: string): Promise<void>`
  - `removeDir(path: string): Promise<void>`

- **logger.ts**: Pretty console output
  - `info(message: string): void`
  - `success(message: string): void`
  - `warn(message: string): void`
  - `error(message: string): void`
  - `spinner(text: string): Ora`
  - `table(data: any[][]): void`

- **prompts.ts**: User interaction
  - `confirm(message: string, defaultValue?: boolean): Promise<boolean>`
  - `select<T>(message: string, choices: Array<{label: string, value: T}>): Promise<T>`
  - `multiSelect<T>(message: string, choices: Array<{label: string, value: T, checked?: boolean}>): Promise<T[]>`
  - `input(message: string, defaultValue?: string): Promise<string>`

### Phase 2: Core Commands

#### Task 2.1: `init` Command
**Status:** Not Started  
**File:** `src/commands/init.ts`  
**Priority:** High

**Functionality:**
- Check if current directory is a git repository
- Create `.arashi/` directory structure
- Generate default `config.json`
- Create `repos/` folder
- Add `repos/` to `.gitignore` (if not already present)
- Discover any existing repositories in `repos/`
- Create example hook files with templates

**CLI Usage:**
```bash
arashi init [options]
Options:
  --repos-dir <name>    Name of repos directory (default: "repos")
  --no-auto-setup       Disable automatic setup after worktree creation
```

**Example Output:**
```
✓ Detected git repository
✓ Created .arashi/ directory
✓ Generated config.json
✓ Created repos/ directory
✓ Updated .gitignore
✓ Discovered 2 repositories: frontend, backend

Arashi initialized successfully!
Run 'arashi add <git-url>' to add repositories.
```

#### Task 2.2: `add` Command
**Status:** Not Started  
**File:** `src/commands/add.ts`  
**Priority:** High

**Functionality:**
- Clone repository into `repos/` folder
- Detect default branch
- Check for `setup.sh` script
- Update config.json with repository information
- Optionally create setup script template

**CLI Usage:**
```bash
arashi add <git-url> [name] [options]
Options:
  --name <name>         Custom name for the repository
  --branch <branch>     Default branch (default: auto-detect)
  --no-setup-template   Don't create setup.sh template
```

**Example Output:**
```
Cloning repository into repos/frontend...
✓ Cloned git@github.com:user/frontend.git
✓ Detected default branch: main
✓ Updated config.json
✓ Created setup.sh template

Repository 'frontend' added successfully!
```

#### Task 2.3: `create` Command
**Status:** Not Started  
**File:** `src/commands/create.ts`  
**Priority:** High

**Functionality:**
- Determine worktree location (bare vs regular repo)
- Optionally prompt for repo selection (interactive mode)
- Filter repos based on `--only` flag
- Create main repository worktree
- For each selected repository:
  - Fetch latest from default branch
  - Check if branch exists
  - Handle branch conflicts (prompt user)
  - Create branch from default if needed
  - Set up remote tracking
  - Create worktree in appropriate location
- Run post-create hooks
- Run setup if auto_setup enabled
- Rollback all changes on any failure

**CLI Usage:**
```bash
arashi create <branch-name> [options]
Options:
  -i, --interactive          Select repos interactively
  --only <repos>             Comma-separated list of repos to include
  --path <path>              Custom path for worktree
  --no-setup                 Skip running setup scripts
  --no-track                 Don't set up remote tracking
```

**Example Output:**
```
Creating worktree for branch 'feature-auth'...

Main repository:
  ✓ Created worktree at ../my-repo-feature-auth

Sub-repositories:
  frontend:
    ✓ Fetched latest from origin/main
    ✓ Created branch feature-auth from main
    ✓ Set upstream tracking to origin/feature-auth
    ✓ Created worktree at ../my-repo-feature-auth/repos/frontend
  
  backend:
    ⚠ Branch 'feature-auth' already exists
    ? What would you like to do? (Use arrow keys)
      ❯ Use existing branch
        Create new branch 'feature-auth-2'
        Abort operation
    
    ✓ Using existing branch
    ✓ Created worktree at ../my-repo-feature-auth/repos/backend

Running setup scripts...
  ✓ frontend setup completed
  ✓ backend setup completed

✓ Worktree created successfully!
```

### Phase 3: Management Commands

#### Task 3.1: `list` Command
**Status:** Not Started  
**File:** `src/commands/list.ts`  
**Priority:** Medium

**Functionality:**
- List all worktrees for main repository
- For each worktree, show branch, path, and status
- Display sub-repository worktrees and their status
- Show clean/dirty indicators
- Support detailed and compact views

**CLI Usage:**
```bash
arashi list [options]
Options:
  --verbose, -v          Show detailed information
  --json                 Output in JSON format
```

**Example Output:**
```
Worktrees:

feature-auth (../my-repo-feature-auth)
  Status: clean
  Sub-repos:
    frontend (main → feature-auth) - clean
    backend (master → feature-auth) - dirty (2 modified files)

feature-payments (../my-repo-feature-payments)
  Status: dirty (1 modified file)
  Sub-repos:
    frontend (main → feature-payments) - clean
    backend (master → feature-payments) - clean

Total: 2 worktrees
```

#### Task 3.2: `remove` Command
**Status:** Not Started  
**File:** `src/commands/remove.ts`  
**Priority:** Medium

**Functionality:**
- Remove worktrees for main and all sub-repositories
- Delete local branches in main and sub-repos (unless --keep-branches)
- Prompt for confirmation (unless --force)
- Handle cases where worktree is dirty
- Clean up git worktree references

**CLI Usage:**
```bash
arashi remove <branch-name> [options]
Options:
  -k, --keep-branches    Don't delete local branches
  -w, --keep-worktrees   Don't remove worktrees (only delete branches)
  -f, --force            Skip confirmation prompts
  --no-check-dirty       Remove even if worktrees have uncommitted changes
```

**Example Output:**
```
Removing worktree 'feature-auth'...

The following will be removed:
  Main worktree: ../my-repo-feature-auth
  Sub-repos:
    - frontend: ../my-repo-feature-auth/repos/frontend
    - backend: ../my-repo-feature-auth/repos/backend

⚠ Warning: backend has uncommitted changes
? Continue? (y/N) y

Removing worktrees...
  ✓ Removed frontend worktree
  ✓ Removed backend worktree
  ✓ Removed main worktree

Deleting branches...
  ✓ Deleted frontend/feature-auth
  ✓ Deleted backend/feature-auth
  ✓ Deleted feature-auth

✓ Worktree removed successfully!
```

#### Task 3.3: `setup` Command
**Status:** Not Started  
**File:** `src/commands/setup.ts`  
**Priority:** Medium

**Functionality:**
- Run `.arashi/hooks/setup.sh` if present
- Run `setup.sh` in each sub-repository if present
- Support running setup for specific repos only
- Display progress and output
- Handle failures gracefully

**CLI Usage:**
```bash
arashi setup [options]
Options:
  --only <repos>         Run setup only for specified repos
  --parallel            Run setup scripts in parallel (default: sequential)
  --verbose, -v         Show full output from setup scripts
```

**Example Output:**
```
Running setup scripts...

Main repository:
  ✓ Completed .arashi/hooks/setup.sh (2.1s)

Sub-repositories:
  frontend:
    Running npm install...
    ✓ Completed (45.3s)
  
  backend:
    Running pip install -r requirements.txt...
    ✓ Completed (12.7s)

✓ Setup completed successfully!
```

#### Task 3.4: `status` Command
**Status:** Not Started  
**File:** `src/commands/status.ts`  
**Priority:** Medium

**Functionality:**
- Show git status for main repository
- Show git status for each sub-repository
- Display current branch for each repo
- Show ahead/behind remote tracking branch
- Color-coded output (clean=green, dirty=yellow, errors=red)
- Support compact and detailed views

**CLI Usage:**
```bash
arashi status [options]
Options:
  --verbose, -v          Show detailed git status
  --short, -s            Compact output
```

**Example Output:**
```
Main repository (feature-auth):
  ✓ On branch feature-auth
  ✓ Your branch is up to date with 'origin/feature-auth'
  ✓ nothing to commit, working tree clean

Sub-repositories:

frontend (feature-auth):
  ✓ On branch feature-auth
  ✓ Your branch is ahead of 'origin/feature-auth' by 2 commits
  ⚠ Changes not staged for commit:
      modified: src/auth/login.tsx
      modified: src/auth/register.tsx

backend (feature-auth):
  ✓ On branch feature-auth
  ✓ Your branch is up to date with 'origin/feature-auth'
  ✓ nothing to commit, working tree clean

Summary: 1 dirty, 2 clean
```

### Phase 4: Advanced Features

#### Task 4.1: Branch Conflict Resolution
**Status:** Not Started  
**Integration:** Part of `create` command

**Functionality:**
- Detect when branch already exists in sub-repository
- Check if existing branch points to expected commit
- Prompt user with options:
  - Use existing branch (checkout and use as-is)
  - Create new branch with numeric suffix (feature-x-2)
  - Abort operation
- Handle user choice appropriately

**Implementation:**
```typescript
async function handleBranchConflict(
  repoName: string,
  branchName: string
): Promise<'use-existing' | 'create-new' | 'abort'> {
  const choice = await select({
    message: `Branch '${branchName}' already exists in '${repoName}'. What would you like to do?`,
    choices: [
      { label: 'Use existing branch', value: 'use-existing' },
      { label: 'Create new branch with suffix', value: 'create-new' },
      { label: 'Abort operation', value: 'abort' }
    ]
  });
  return choice;
}
```

#### Task 4.2: Interactive Repo Selection
**Status:** Not Started  
**Integration:** Part of `create` command with `-i/--interactive` flag

**Functionality:**
- Display checkbox list of all available repositories
- Allow user to select/deselect repositories
- All repositories selected by default
- Update worktree creation to only process selected repos

**Implementation:**
```typescript
async function selectRepos(availableRepos: string[]): Promise<string[]> {
  const selected = await multiSelect({
    message: 'Select repositories to include:',
    choices: availableRepos.map(repo => ({
      label: repo,
      value: repo,
      checked: true // All checked by default
    }))
  });
  return selected;
}
```

#### Task 4.3: Error Handling & Rollback
**Status:** Not Started  
**Integration:** All commands

**Functionality:**
- Track all operations during command execution
- On error, rollback completed operations
- Log rollback steps
- Provide clear error messages
- Suggest fixes for common errors

**Implementation Pattern:**
```typescript
const operations: Operation[] = [];

try {
  // Perform operations
  const mainWorktree = await createWorktree(/* ... */);
  operations.push({ type: 'worktree', path: mainWorktree });
  
  for (const repo of repos) {
    const repoWorktree = await createWorktree(/* ... */);
    operations.push({ type: 'worktree', path: repoWorktree, repo });
  }
} catch (error) {
  logger.error('Operation failed, rolling back...');
  
  // Rollback in reverse order
  for (const op of operations.reverse()) {
    await rollbackOperation(op);
  }
  
  throw error;
}
```

#### Task 4.4: Hook System
**Status:** Not Started  
**Files:** Hook execution in relevant commands

**Functionality:**
- Support for lifecycle hooks:
  - `pre-create.sh`: Before creating worktrees
  - `post-create.sh`: After creating worktrees
  - `setup.sh`: Custom setup logic
- Pass context to hooks as environment variables
- Capture and display hook output
- Handle hook failures appropriately

**Hook Environment Variables:**
```bash
ARASHI_COMMAND=create
ARASHI_BRANCH=feature-auth
ARASHI_WORKTREE_PATH=../my-repo-feature-auth
ARASHI_REPOS_DIR=repos
ARASHI_REPO_LIST=frontend,backend
```

### Phase 5: Polish & Distribution

#### Task 5.1: Build Configuration
**Status:** Not Started  
**Files:** `package.json` (scripts already defined)

**Functionality:**
- Single file executable for macOS (ARM64)
- Single file executable for Linux (x64)
- Single file executable for Windows (x64)
- Optimize binary size
- Include source maps for debugging

**Commands:**
```bash
bun run build          # Build for current platform
bun run build:all      # Build for all platforms
bun run build:mac      # Build for macOS ARM64
bun run build:linux    # Build for Linux x64
bun run build:windows  # Build for Windows x64
```

#### Task 5.2: Documentation
**Status:** Not Started  
**File:** `README.md`

**Content:**
- What is Arashi?
- Installation instructions (multiple methods)
- Quick start guide
- Command reference with examples
- Configuration options
- Hook system documentation
- Use cases and best practices
- Troubleshooting guide
- Contributing guidelines
- License information

#### Task 5.3: Testing
**Status:** Not Started  
**Directory:** `tests/`

**Test Coverage:**
- Unit tests for utility functions
- Integration tests for commands
- End-to-end workflow tests
- Edge case handling
- Error scenarios and rollback

**Test Structure:**
```
tests/
├── unit/
│   ├── git.test.ts
│   ├── config.test.ts
│   └── filesystem.test.ts
├── integration/
│   ├── init.test.ts
│   ├── create.test.ts
│   └── remove.test.ts
└── e2e/
    └── full-workflow.test.ts
```

#### Task 5.4: Installation Scripts
**Status:** Not Started  
**Files:** `install.sh`, `install.ps1`

**Functionality:**
- Detect operating system and architecture
- Download appropriate binary
- Install to system PATH
- Verify installation
- Provide next steps

**Installation Methods:**
1. **Direct binary download**
2. **Install script (curl/wget)**
3. **npm package** (future)
4. **Homebrew tap** (future)

## Design Decisions

### 1. Worktree Location Strategy

**Decision:** Auto-detect based on repository type
- **Bare repositories:** Create worktrees inside the repository directory
- **Regular repositories:** Create worktrees as siblings to the main repository

**Rationale:** This follows git's conventional patterns and user expectations.

**Override:** Users can specify custom path with `--path` flag.

### 2. Branch Creation Strategy

**Decision:** Pull latest from default branch, then create new branch
- Fetch latest from remote default branch
- Create local branch from latest default
- Set up remote tracking automatically

**Rationale:** Ensures worktrees start from latest stable code.

### 3. Configuration Storage

**Decision:** Store in `.arashi/config.json` in main repository
- Version controlled configuration
- Auto-discovery of repositories on init
- Manual additions possible

**Rationale:** Keep configuration close to the code, allow team sharing.

### 4. Sub-repository Discovery

**Decision:** Auto-discover git repositories in `repos/` folder
- Scan `repos/` for git repositories on init
- Update config automatically
- Allow manual additions via `add` command

**Rationale:** Minimize manual configuration, but allow flexibility.

### 5. Error Handling Philosophy

**Decision:** Rollback all changes on any error
- Track operations during execution
- On failure, reverse all completed operations
- Leave repository in clean state

**Rationale:** Prevent partial/broken worktree setups.

### 6. Setup Script Execution

**Decision:** Sequential by default, parallel via flag
- Run setup scripts one at a time (default)
- Option to run in parallel with `--parallel`
- Each repo can have its own `setup.sh`

**Rationale:** Some setup scripts may have dependencies; allow optimization when safe.

### 7. Remote Tracking

**Decision:** Always set up remote tracking
- Branches automatically track remote
- Simplifies push/pull operations
- Follows git best practices

**Rationale:** Most common workflow, reduces user errors.

### 8. Branch Deletion

**Decision:** Delete by default, with opt-out flags
- `remove` command deletes both worktrees and branches
- `--keep-branches` to preserve branches
- `--keep-worktrees` to only delete branches

**Rationale:** Clean up fully by default, but provide flexibility.

## Open Questions

### 1. Bare Repository Detection
Should we auto-detect bare repos or allow users to override with a flag?

**Proposal:** Auto-detect, with `--worktree-location` flag to override.

### 2. Git Credentials
Should we handle git credential/SSH key issues?

**Proposal:** Assume user has proper git access configured; provide helpful error messages.

### 3. Naming Convention for Conflicting Branches
When branch conflicts occur and user chooses to create new branch, what suffix to use?

**Options:**
- Numeric suffix: `feature-x-2`, `feature-x-3`
- Timestamp: `feature-x-20260202`
- Random: `feature-x-a3f9`

**Proposal:** Numeric suffix (simplest and most predictable).

### 4. Setup Script Parallelization
Should setup scripts run in parallel by default?

**Proposal:** Sequential by default (safer), with `--parallel` flag for optimization.

### 5. Configuration Version Tracking
Should config file track which version of arashi created it?

**Proposal:** Yes, include version in config for future migrations.

### 6. Hook Execution Security
Should we validate/sandbox hook execution?

**Proposal:** Warn users about hook execution, check execute permissions, allow `--no-hooks` flag.

## Success Metrics

### User Experience
- Single command to create coordinated worktrees
- Clear, informative output
- Graceful error handling
- Fast execution (< 30s for 5 repos)

### Code Quality
- Type-safe TypeScript
- Test coverage > 80%
- Comprehensive error handling
- Well-documented code

### Distribution
- Single binary < 50MB
- Works on macOS, Linux, Windows
- No runtime dependencies
- Easy installation

## Future Enhancements

### Post-1.0 Features
- Workspace templates (predefined repo sets)
- Remote worktree management (SSH)
- Integration with VS Code/JetBrains
- GitHub/GitLab CI/CD integration
- Worktree naming patterns (user-feature-x)
- Stash management across repos
- Bulk operations (rebase, merge)
- Analytics and usage tracking (opt-in)

### Community Features
- Plugin system
- Custom command extensions
- Shared configuration presets
- Web dashboard for worktree management

## Contributing

### Development Setup
```bash
# Clone repository
git clone https://github.com/user/arashi.git
cd arashi

# Install dependencies
bun install

# Run in development mode
bun run dev

# Run tests
bun test

# Build
bun run build
```

### Code Style
- Use TypeScript strict mode
- Follow ESLint configuration
- Write tests for new features
- Document public APIs
- Use conventional commits

### Pull Request Process
1. Create feature branch
2. Implement feature with tests
3. Update documentation
4. Submit PR with description
5. Address review feedback

## License

MIT License - See LICENSE file for details.

---

**Document Version:** 1.0  
**Last Updated:** February 2, 2026  
**Status:** Living Document
