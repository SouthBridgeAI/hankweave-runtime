# Task: Migrate Hankweave to Monorepo

## Summary

Migrate the Hankweave project from its current multi-repository structure into a unified monorepo. This includes the runtime (`hankweave`), documentation (`hankweave-docs`), and any related packages/tools.

## Goals

- Consolidate all Hankweave repositories into a single monorepo
- Maintain clean package boundaries with proper workspace configuration
- Preserve git history where practical
- Ensure CI/CD pipelines work with the new structure
- Keep the developer experience smooth (build, test, lint across packages)

## Context

Hankweave currently spans multiple repos (runtime, docs, potentially shims/tools). Coordinating changes across repos creates friction - a feature that touches both runtime and docs requires multiple PRs, version bumps, and careful sequencing. A monorepo would simplify cross-cutting changes and dependency management.

## Considerations

- Bun workspaces vs other monorepo tooling (turborepo, nx, etc.)
- Package publishing strategy (npm packages from monorepo)
- Schema sharing between packages
- Test infrastructure consolidation
- Documentation site build integration
- Binary build pipeline for cross-platform releases
