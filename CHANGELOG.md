## [1.1.1](https://github.com/corwinm/arashi/compare/v1.1.0...v1.1.1) (2026-02-07)

### Bug Fixes

* use package.json version instead of hardcoded value in CLI ([e66b6f5](https://github.com/corwinm/arashi/commit/e66b6f50513a8bf66b45ebbcabcda2bab176df91))

## [1.1.0](https://github.com/corwinm/arashi/compare/v1.0.0...v1.1.0) (2026-02-07)

### Features

* implement postinstall script to download binaries from GitHub releases ([c169732](https://github.com/corwinm/arashi/commit/c1697325f06185bd4006e0003691142db61319bf))
* skip binary download in development environment ([136b391](https://github.com/corwinm/arashi/commit/136b391a973b78bd4fb56e0bb4e65e13bb2b3498))

### Code Refactoring

* move all dependencies to devDependencies ([6a813ef](https://github.com/corwinm/arashi/commit/6a813eff22da11495dfa5781bf9bf5333663216e))

## 1.0.0 (2026-02-07)

### Features

* Add GitHub Actions release workflow with semantic versioning ([#14](https://github.com/corwinm/arashi/issues/14)) ([bc3bde6](https://github.com/corwinm/arashi/commit/bc3bde67ca3a55560d3f37ac7bd953887efe9d7d))
* **ci:** Add GitHub Actions CI workflow ([#8](https://github.com/corwinm/arashi/issues/8)) ([b7b1e78](https://github.com/corwinm/arashi/commit/b7b1e78c2f3b1a8fa3af58a79824497c70d81ed3)), closes [#35](https://github.com/corwinm/arashi/issues/35)
* **config:** implement configuration management module ([#2](https://github.com/corwinm/arashi/issues/2)) ([4639d92](https://github.com/corwinm/arashi/commit/4639d9239db7df184b324a656cf353467ee17667))
* Fix nested worktree paths for child repositories (User Story 1) [#55](https://github.com/corwinm/arashi/issues/55) ([#10](https://github.com/corwinm/arashi/issues/10)) ([92046de](https://github.com/corwinm/arashi/commit/92046de00b3917de7159de4e8a00b4511ab85908))
* implement add command ([#13](https://github.com/corwinm/arashi/issues/13)) ([a8ebcab](https://github.com/corwinm/arashi/commit/a8ebcab4ac56a8e9c2bb7609216f04d199dae5e5))
* Implement Git Utility Library (Phase 1-3) ([#1](https://github.com/corwinm/arashi/issues/1)) ([0e88f1d](https://github.com/corwinm/arashi/commit/0e88f1da6cc0c083fc6eb85d7a9a3c853bbd09bf))
* Implement init command (Issue [#9](https://github.com/corwinm/arashi/issues/9)) ([#9](https://github.com/corwinm/arashi/issues/9)) ([73df820](https://github.com/corwinm/arashi/commit/73df820293b27d0ab096c709bd9ba910d9c437bb))
* implement lifecycle hook system (MVP) ([#4](https://github.com/corwinm/arashi/issues/4)) ([c780688](https://github.com/corwinm/arashi/commit/c780688b510b2bd9f56ec9e21a9d3affff8f9945)), closes [arashi-arashi/utilities#19](https://github.com/arashi-arashi/utilities/issues/19)
* Implement list command with context-aware worktree listing ([#11](https://github.com/corwinm/arashi/issues/11)) ([558d593](https://github.com/corwinm/arashi/commit/558d59349e300eea40ec6048116598cab27ad58d))
* implement repository management system (Issue [#22](https://github.com/corwinm/arashi/issues/22)) ([#5](https://github.com/corwinm/arashi/issues/5)) ([5a68032](https://github.com/corwinm/arashi/commit/5a680327a85f7bd258e64ba41ffb5bb3c28d4d70)), closes [arashi-arashi/utilities#19](https://github.com/arashi-arashi/utilities/issues/19)
* implement rollback mechanism (MVP) ([#6](https://github.com/corwinm/arashi/issues/6)) ([2290a53](https://github.com/corwinm/arashi/commit/2290a532551b60c23a5922da9b56b50b853b6202))
* Implement Utility Libraries (Filesystem, Logger, Prompts) ([#3](https://github.com/corwinm/arashi/issues/3)) ([5854680](https://github.com/corwinm/arashi/commit/58546804c975d15fd0d2e458def67b6c6d0f08bb))
* implement worktree orchestration with interactive features ([#7](https://github.com/corwinm/arashi/issues/7)) ([061f220](https://github.com/corwinm/arashi/commit/061f220b41e2f29e99636a6b0ba7de6e0af7a92b)), closes [#23](https://github.com/corwinm/arashi/issues/23)

### Bug Fixes

* add missing conventional-changelog-conventionalcommits dependency for semantic-release ([b5b5683](https://github.com/corwinm/arashi/commit/b5b5683acce37b1c6b32f864d2c4198d383ab4e8))
* Enable fzf piping compatibility with shell wrapper ([#12](https://github.com/corwinm/arashi/issues/12)) ([50e0b19](https://github.com/corwinm/arashi/commit/50e0b193785b98a6f9c58120349103a8fde27775))
* update repository URLs from placeholder to corwinm/arashi ([36ef23e](https://github.com/corwinm/arashi/commit/36ef23eab1b5657d652eafa6c54ef3933d34c1cc))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Releases will be automatically added here by semantic-release -->
