## [1.11.2](https://github.com/corwinm/arashi/compare/v1.11.1...v1.11.2) (2026-05-08)

### Bug Fixes

- windows cli improvements ([#59](https://github.com/corwinm/arashi/issues/59)) ([baaf56c](https://github.com/corwinm/arashi/commit/baaf56cd0914aef88f8fadfd68e7c083a3ce95f9))

## [1.11.1](https://github.com/corwinm/arashi/compare/v1.11.0...v1.11.1) (2026-04-19)

### Bug Fixes

- **release:** pin bun and verify installed binaries ([8eaa18f](https://github.com/corwinm/arashi/commit/8eaa18f3010befe53f08372fe467648d6145d903))

## [1.11.0](https://github.com/corwinm/arashi/compare/v1.10.1...v1.11.0) (2026-04-19)

### Features

- add editor-scoped create defaults ([#57](https://github.com/corwinm/arashi/issues/57)) ([83ab2c8](https://github.com/corwinm/arashi/commit/83ab2c8024fed36b1c668c8bcd5b009a56da63b6))

### Bug Fixes

- **status:** inline missing remote branch warnings ([#56](https://github.com/corwinm/arashi/issues/56)) ([a41c21d](https://github.com/corwinm/arashi/commit/a41c21d4696c64b414d8d9447a76c6dc2942acfd))
- **status:** show default-branch drift in status output ([#58](https://github.com/corwinm/arashi/issues/58)) ([9d154fc](https://github.com/corwinm/arashi/commit/9d154fcf6279b2499bff4d391f278efca6104806))

## [1.10.1](https://github.com/corwinm/arashi/compare/v1.10.0...v1.10.1) (2026-04-07)

### Bug Fixes

- **status:** refresh remote tracking before reporting branch state ([#138](https://github.com/corwinm/arashi/issues/138)) ([#53](https://github.com/corwinm/arashi/issues/53)) ([1dcbf6d](https://github.com/corwinm/arashi/commit/1dcbf6dfe8d08e11855667398ab9ba07c3fff770))
- surface linked child repo status in list output ([#54](https://github.com/corwinm/arashi/issues/54)) ([39bf320](https://github.com/corwinm/arashi/commit/39bf3209e86720ca65f195480c3a96d915d8faeb))

## [1.10.0](https://github.com/corwinm/arashi/compare/v1.9.0...v1.10.0) (2026-03-31)

### Features

- add shell-integrated switch cd flow ([#51](https://github.com/corwinm/arashi/issues/51)) ([75aadb1](https://github.com/corwinm/arashi/commit/75aadb178fc41207a0e6c1be01c957db392b3ac6))
- **init:** bootstrap repos from non-git directories ([#49](https://github.com/corwinm/arashi/issues/49)) ([a5ec11c](https://github.com/corwinm/arashi/commit/a5ec11cae023330d73d8fff1875b3c344e813a84))

### Bug Fixes

- add exact-path switch targeting ([#131](https://github.com/corwinm/arashi/issues/131)) ([f4a9be1](https://github.com/corwinm/arashi/commit/f4a9be1f0ef8ac97751505f2aae755d651ebb4fb))

## [1.9.0](https://github.com/corwinm/arashi/compare/v1.8.2...v1.9.0) (2026-03-30)

### Features

- add IDE-aware switch launch overrides ([#48](https://github.com/corwinm/arashi/issues/48)) ([57afa87](https://github.com/corwinm/arashi/commit/57afa878bb957e73690fef70d0bf6eb6068446f8))

## [1.8.2](https://github.com/corwinm/arashi/compare/v1.8.1...v1.8.2) (2026-02-24)

### Bug Fixes

- **init:** restore managed worktree gitignore updates ([#45](https://github.com/corwinm/arashi/issues/45)) ([3fd71a9](https://github.com/corwinm/arashi/commit/3fd71a94d5ee6786ead3a8b9cbac828bc0d507a7))

## [1.8.1](https://github.com/corwinm/arashi/compare/v1.8.0...v1.8.1) (2026-02-24)

### Bug Fixes

- **init:** stop auto-adding default worktrees ignore ([#43](https://github.com/corwinm/arashi/issues/43)) ([2acb282](https://github.com/corwinm/arashi/commit/2acb28282ba68392b600c31a61075ebc54232643))

## [1.8.0](https://github.com/corwinm/arashi/compare/v1.7.0...v1.8.0) (2026-02-23)

### Features

- add configurable create and switch defaults ([#41](https://github.com/corwinm/arashi/issues/41)) ([d65dfa4](https://github.com/corwinm/arashi/commit/d65dfa48a3cef851561ec439013d3507809eff24))
- add configurable worktree base location support ([#40](https://github.com/corwinm/arashi/issues/40)) ([a491d31](https://github.com/corwinm/arashi/commit/a491d31f5ce8e06d37fda485a54a14d36d9b38e7))
- add JSON Schema for Arashi config ([#39](https://github.com/corwinm/arashi/issues/39)) ([ca4dbae](https://github.com/corwinm/arashi/commit/ca4dbaee4e5a89f9d043305364d339a6bb59c112))
- **hooks:** expand remove hook scope and ordering ([#42](https://github.com/corwinm/arashi/issues/42)) ([74c710c](https://github.com/corwinm/arashi/commit/74c710c3b3e1f91e35084ae4f6f6c23338d4eb79))

## [1.7.0](https://github.com/corwinm/arashi/compare/v1.6.0...v1.7.0) (2026-02-19)

### Features

- add clone command and missing-repo recovery ([#38](https://github.com/corwinm/arashi/issues/38)) ([bcf2fa7](https://github.com/corwinm/arashi/commit/bcf2fa7a14a51450c4f095e8d1fe2df03ab71a0a))
- add pre/post remove lifecycle hooks ([#37](https://github.com/corwinm/arashi/issues/37)) ([56d5962](https://github.com/corwinm/arashi/commit/56d5962022892407f4ef8235ff4a68d1ebd0bf7d))

### Bug Fixes

- streamline installer loading animation ([226715b](https://github.com/corwinm/arashi/commit/226715bb71a2876733ac07dc25d73bab31f148d9))

## [1.6.0](https://github.com/corwinm/arashi/compare/v1.5.1...v1.6.0) (2026-02-17)

### Features

- add switch command for faster worktree navigation ([#36](https://github.com/corwinm/arashi/issues/36)) ([f410bb5](https://github.com/corwinm/arashi/commit/f410bb5b7e0e34b4116243560f77d84d9b341dc9))

### Bug Fixes

- Ensure binary is available if postinstall is blocked or fails ([8194a80](https://github.com/corwinm/arashi/commit/8194a80445a950e45a3d8f1db1d638bed55fa796))
- run create hooks from canonical workspace context ([#35](https://github.com/corwinm/arashi/issues/35)) ([2975e8d](https://github.com/corwinm/arashi/commit/2975e8dacc8b62c64d25587fac919e80a26ae598))

## [1.5.1](https://github.com/corwinm/arashi/compare/v1.5.0...v1.5.1) (2026-02-15)

### Bug Fixes

- Fix bugs in install script output ([#33](https://github.com/corwinm/arashi/issues/33)) ([4bef325](https://github.com/corwinm/arashi/commit/4bef32585eeb034cda36ec4fb7463d8b96018b53))
- improve Windows CLI launch wrapper ([#34](https://github.com/corwinm/arashi/issues/34)) ([be21ccc](https://github.com/corwinm/arashi/commit/be21ccc83e12f5c3e6aea37eb629ded36d76156a))

## [1.5.0](https://github.com/corwinm/arashi/compare/v1.4.0...v1.5.0) (2026-02-12)

### Features

- add curl installer with checksum-based release integrity ([#32](https://github.com/corwinm/arashi/issues/32)) ([94322f0](https://github.com/corwinm/arashi/commit/94322f06ce8063811c5cedfab35a438a7f71036e))
- add unified logo assets and CLI help banner variants ([#31](https://github.com/corwinm/arashi/issues/31)) ([2c84553](https://github.com/corwinm/arashi/commit/2c845534dcd19460e66b0cadfd4f4718a23c802c))

## [1.4.0](https://github.com/corwinm/arashi/compare/v1.3.0...v1.4.0) (2026-02-11)

### Features

- **setup:** add workspace setup orchestration command ([#24](https://github.com/corwinm/arashi/issues/24)) ([ddea8c4](https://github.com/corwinm/arashi/commit/ddea8c443bfa8779ce11139a5017ac4c089e262d))

### Bug Fixes

- support create command from bare repositories ([#26](https://github.com/corwinm/arashi/issues/26)) ([62c2e1d](https://github.com/corwinm/arashi/commit/62c2e1d85184cfe04a195f897585efdd5227b293))

## [1.3.0](https://github.com/corwinm/arashi/compare/v1.2.0...v1.3.0) (2026-02-09)

### Features

- add pull command ([#20](https://github.com/corwinm/arashi/issues/20)) ([a2b4df1](https://github.com/corwinm/arashi/commit/a2b4df16f63e5265229a64f747b3c60f4a338205))
- **hooks:** repo-specific create hooks ([#22](https://github.com/corwinm/arashi/issues/22)) ([74d33dd](https://github.com/corwinm/arashi/commit/74d33dd17eb25d47744706245a9c79cac50d30d6))
- **sync:** add branch alignment workflow ([#21](https://github.com/corwinm/arashi/issues/21)) ([c2c758b](https://github.com/corwinm/arashi/commit/c2c758b4339c3f9c29fc6dd9cb30451a8c77d8ae))

### Bug Fixes

- **create:** honor dry-run plan output ([#23](https://github.com/corwinm/arashi/issues/23)) ([c9a0a97](https://github.com/corwinm/arashi/commit/c9a0a9721d79f51f287a5062aae02b8cbe1d1cef))
- **pull:** handle repos without upstream ([404a759](https://github.com/corwinm/arashi/commit/404a7591baa43d610bca93b04cda0af27e59dc1b))

## [1.2.0](https://github.com/corwinm/arashi/compare/v1.1.3...v1.2.0) (2026-02-08)

### Features

- **remove:** add remove command workflow ([#17](https://github.com/corwinm/arashi/issues/17)) ([a32b5e4](https://github.com/corwinm/arashi/commit/a32b5e4e90bcb4254684ad145c2fd95c547d87aa))
- **status:** implement status command with workspace discovery ([#15](https://github.com/corwinm/arashi/issues/15)) ([3af1162](https://github.com/corwinm/arashi/commit/3af1162372b3cd0f28bc8e9d00c3cfb7a3bd15ce))

### Bug Fixes

- improve prompt handling and vim navigation ([#18](https://github.com/corwinm/arashi/issues/18)) ([940a636](https://github.com/corwinm/arashi/commit/940a6369d45c50066f3417213d490a1bf94d7c5e))
- isBareRepo now correctly detects worktrees of bare repositories ([#16](https://github.com/corwinm/arashi/issues/16)) ([6eb14e3](https://github.com/corwinm/arashi/commit/6eb14e3d114e88808893446a13020944a7a8fbb8))
- **remove:** align selection with worktree hierarchy ([#19](https://github.com/corwinm/arashi/issues/19)) ([02bbb32](https://github.com/corwinm/arashi/commit/02bbb327336973d1bd8e0bcedcc69b7cd266a00b))

## [1.1.3](https://github.com/corwinm/arashi/compare/v1.1.2...v1.1.3) (2026-02-07)

### Bug Fixes

- simplify release workflow and build binaries after version bump ([fb4cb26](https://github.com/corwinm/arashi/commit/fb4cb26faae144a5dd77a68794a465be04848cda))

## [1.1.2](https://github.com/corwinm/arashi/compare/v1.1.1...v1.1.2) (2026-02-07)

### Bug Fixes

- rebuild binaries after version bump to ensure correct version is embedded ([8cdcdf6](https://github.com/corwinm/arashi/commit/8cdcdf6fdab84557824988526a8e80fe1f9baf78))
- use temporary config file replacement for semantic-release ([12804b7](https://github.com/corwinm/arashi/commit/12804b7a1224666245de566d003568a77d427324))

## [1.1.1](https://github.com/corwinm/arashi/compare/v1.1.0...v1.1.1) (2026-02-07)

### Bug Fixes

- use package.json version instead of hardcoded value in CLI ([e66b6f5](https://github.com/corwinm/arashi/commit/e66b6f50513a8bf66b45ebbcabcda2bab176df91))

## [1.1.0](https://github.com/corwinm/arashi/compare/v1.0.0...v1.1.0) (2026-02-07)

### Features

- implement postinstall script to download binaries from GitHub releases ([c169732](https://github.com/corwinm/arashi/commit/c1697325f06185bd4006e0003691142db61319bf))
- skip binary download in development environment ([136b391](https://github.com/corwinm/arashi/commit/136b391a973b78bd4fb56e0bb4e65e13bb2b3498))

### Code Refactoring

- move all dependencies to devDependencies ([6a813ef](https://github.com/corwinm/arashi/commit/6a813eff22da11495dfa5781bf9bf5333663216e))

## 1.0.0 (2026-02-07)

### Features

- Add GitHub Actions release workflow with semantic versioning ([#14](https://github.com/corwinm/arashi/issues/14)) ([bc3bde6](https://github.com/corwinm/arashi/commit/bc3bde67ca3a55560d3f37ac7bd953887efe9d7d))
- **ci:** Add GitHub Actions CI workflow ([#8](https://github.com/corwinm/arashi/issues/8)) ([b7b1e78](https://github.com/corwinm/arashi/commit/b7b1e78c2f3b1a8fa3af58a79824497c70d81ed3)), closes [#35](https://github.com/corwinm/arashi/issues/35)
- **config:** implement configuration management module ([#2](https://github.com/corwinm/arashi/issues/2)) ([4639d92](https://github.com/corwinm/arashi/commit/4639d9239db7df184b324a656cf353467ee17667))
- Fix nested worktree paths for child repositories (User Story 1) [#55](https://github.com/corwinm/arashi/issues/55) ([#10](https://github.com/corwinm/arashi/issues/10)) ([92046de](https://github.com/corwinm/arashi/commit/92046de00b3917de7159de4e8a00b4511ab85908))
- implement add command ([#13](https://github.com/corwinm/arashi/issues/13)) ([a8ebcab](https://github.com/corwinm/arashi/commit/a8ebcab4ac56a8e9c2bb7609216f04d199dae5e5))
- Implement Git Utility Library (Phase 1-3) ([#1](https://github.com/corwinm/arashi/issues/1)) ([0e88f1d](https://github.com/corwinm/arashi/commit/0e88f1da6cc0c083fc6eb85d7a9a3c853bbd09bf))
- Implement init command (Issue [#9](https://github.com/corwinm/arashi/issues/9)) ([#9](https://github.com/corwinm/arashi/issues/9)) ([73df820](https://github.com/corwinm/arashi/commit/73df820293b27d0ab096c709bd9ba910d9c437bb))
- implement lifecycle hook system (MVP) ([#4](https://github.com/corwinm/arashi/issues/4)) ([c780688](https://github.com/corwinm/arashi/commit/c780688b510b2bd9f56ec9e21a9d3affff8f9945)), closes [arashi-arashi/utilities#19](https://github.com/arashi-arashi/utilities/issues/19)
- Implement list command with context-aware worktree listing ([#11](https://github.com/corwinm/arashi/issues/11)) ([558d593](https://github.com/corwinm/arashi/commit/558d59349e300eea40ec6048116598cab27ad58d))
- implement repository management system (Issue [#22](https://github.com/corwinm/arashi/issues/22)) ([#5](https://github.com/corwinm/arashi/issues/5)) ([5a68032](https://github.com/corwinm/arashi/commit/5a680327a85f7bd258e64ba41ffb5bb3c28d4d70)), closes [arashi-arashi/utilities#19](https://github.com/arashi-arashi/utilities/issues/19)
- implement rollback mechanism (MVP) ([#6](https://github.com/corwinm/arashi/issues/6)) ([2290a53](https://github.com/corwinm/arashi/commit/2290a532551b60c23a5922da9b56b50b853b6202))
- Implement Utility Libraries (Filesystem, Logger, Prompts) ([#3](https://github.com/corwinm/arashi/issues/3)) ([5854680](https://github.com/corwinm/arashi/commit/58546804c975d15fd0d2e458def67b6c6d0f08bb))
- implement worktree orchestration with interactive features ([#7](https://github.com/corwinm/arashi/issues/7)) ([061f220](https://github.com/corwinm/arashi/commit/061f220b41e2f29e99636a6b0ba7de6e0af7a92b)), closes [#23](https://github.com/corwinm/arashi/issues/23)

### Bug Fixes

- add missing conventional-changelog-conventionalcommits dependency for semantic-release ([b5b5683](https://github.com/corwinm/arashi/commit/b5b5683acce37b1c6b32f864d2c4198d383ab4e8))
- Enable fzf piping compatibility with shell wrapper ([#12](https://github.com/corwinm/arashi/issues/12)) ([50e0b19](https://github.com/corwinm/arashi/commit/50e0b193785b98a6f9c58120349103a8fde27775))
- update repository URLs from placeholder to corwinm/arashi ([36ef23e](https://github.com/corwinm/arashi/commit/36ef23eab1b5657d652eafa6c54ef3933d34c1cc))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Releases will be automatically added here by semantic-release -->
