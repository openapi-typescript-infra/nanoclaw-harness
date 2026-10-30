---
name: macos-checks
description: Run configured macOS and iOS Simulator test recipes through the macos MCP worker when a task needs native Apple tooling.
---

Use the macos_run tool. Its recipe names are installed by the operator; there
is no arbitrary shell command or repository path parameter. Start with
simulators when simulator availability is uncertain, then run ios-tests for
the configured checkout. Report exit status and test evidence.

A busy response means another check owns this VM. Do not repeatedly retry or
claim completion. Missing recipes, missing runtimes, and an unreachable worker
are setup gaps. Distinguish those from application test failures.
