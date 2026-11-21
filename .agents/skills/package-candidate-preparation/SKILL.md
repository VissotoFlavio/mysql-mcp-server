---
name: package-candidate-preparation
description: Prepare MySQL MCP release or hotfix candidate work. Use when updating version metadata, changelog entries, candidate workflow inputs, or release validation.
---

# Package candidate preparation

Read `CHANGELOG.md`, `README.md` and the candidate workflow before release or
hotfix work. Preserve the internal candidate boundary and the required CI
checks for the immutable PR commit.

Run relevant validation and inspect the final diff, but do not generate a
candidate, publish a package, create a release or merge without explicit
authorization.
