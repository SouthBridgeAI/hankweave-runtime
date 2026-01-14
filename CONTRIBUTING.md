# Contributing to Hankweave

Thank you for your interest in contributing to Hankweave! This document outlines our development workflow and contribution guidelines.

## Branch Model

```
feature branches → develop → release/alpha → (future: release/beta, release/stable)
                      ↑
              all PRs target here
```

### Branches

- **`develop`** - Active development branch. All pull requests should target this branch.
- **`release/alpha`** - Default branch. Customer-facing stable releases. Tagged releases are created from this branch.

## How to contribute

### 1. Create a Feature Branch

Create your feature branch from `develop`:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### 2. Make Your Changes

Be good.

### 3. Submit a Pull Request

1. Push your branch to GitHub
2. Open a pull request **targeting `develop`**

## Release Process

Run the appropriate release command from the `develop` branch:

```bash
bun run release:patch  # for bug fixes (0.1.35 → 0.1.36)
bun run release:minor  # for new features (0.1.35 → 0.2.0)
bun run release:major  # for breaking changes (0.1.35 → 1.0.0)
```
