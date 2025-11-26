## Core Execution Concepts

**Execution Environment** - The isolated directory (currently `~/.tadpole-executions/...`) where Tadpole operates on a copy/symlink of user data. This is the safe sandbox that enables rollbacks and keeps the original data untouched.

**Data Source** - The user's original project directory or file that Tadpole reads from but never modifies. This is accessed via symlink or copy at `read_only_data_source/` within the execution environment.

**Workflow Configuration** - The JSON file (currently `phases.json`) that defines the entire multi-step process. This is the blueprint that tells Tadpole what to do, in what order, with what models.

## Execution Units

**Phase** - The atomic unit of work - a single focused task for Claude with its own prompt, model selection, and configuration. Phases are the building blocks that compose into larger workflows.

**Run** - A complete server lifecycle from startup to shutdown, containing multiple phase executions. When you rollback and continue, you create a new run that branches from the previous one.

**Execution Thread** - The logical sequence of phases across potentially multiple runs, stitching together the "true" history after rollbacks. This is what determines "what comes next" in complex, branching histories.

## Agent Architecture

**Primary Agent** - The main Claude process that executes phases and performs the core work. This is the "player on the field" doing the actual task.

**Chronicler** - A parallel, non-blocking observation agent that watches the primary agent's activity stream. These are the "commentators in the booth" that analyze, summarize, or evaluate without interfering.

**Agent Communication Protocol** - The WebSocket-based real-time messaging system between server and clients. This enables live monitoring and interactive control of the workflow.

## State & Versioning

**Shadow Repository** - The hidden git repository in `.tadpole/checkpoints` that versions tracked files. This enables the powerful rollback system without touching the user's actual git repo.

**Checkpoint** - An automatic git commit in the shadow repository at key lifecycle moments. These are the "save points" you can rollback to.

**State Management System** - The event-sourced, append-only system that tracks all runs, phases, and transitions. This ensures complete auditability and crash recovery.

## Runtime Components

**Workspace Setup Operations** - Pre-phase actions like copying templates or running commands. These prepare the environment before Claude starts working.

**File Tracking Patterns** - Glob patterns that specify which files to monitor and checkpoint. This determines what gets versioned and what Claude "sees" changing.

**Session Context** - The conversational history that can be preserved between phases. This enables multi-turn workflows where later phases build on earlier ones.

**Tool Execution System** - Claude's ability to use tools (read, write, bash) with detailed tracking of invocations and results. This includes execution timing and error handling.

## Infrastructure

**LLM Proxy Layer** - The middleware system for intercepting, logging, and modifying requests to Claude's API. This enables cost tracking, rate limiting, and request transformation.

**Lock File Mechanism** - The system preventing multiple server instances from corrupting state. Includes heartbeat monitoring for crash detection.

**Cost Tracking System** - Real-time monitoring of token usage and associated costs per phase. This helps manage budgets and optimize prompts.

**TUI/Client Interface** - The user-facing control mechanism, whether the basic terminal UI or programmatic WebSocket clients. This is how humans interact with the system.

## Meta Concepts

**Tadprogram/Workflow** - The complete package of configuration, prompts, and setup that defines a reusable AI automation. This is the "app" or "recipe" that users share and run.

**Execution Model** - The overall paradigm of isolated, versioned, multi-phase AI workflows. This is the conceptual framework that makes Tadpole different from simple prompt runners.

Are there any other concepts you feel are missing or need clearer distinction? I notice terms like "middleware/guardrails" and "inspect and modify loops" that might represent future features for meta-programming (agents modifying their own workflows).