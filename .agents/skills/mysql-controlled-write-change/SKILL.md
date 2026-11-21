---
name: mysql-controlled-write-change
description: Change MySQL MCP controlled DML or DDL behavior. Use when modifying write-tool opt-ins, target validation, confirmations, audit, destructive safeguards, or no-retry behavior.
---

# MySQL controlled write change

Read `README.md`, `docs/configuration.md`, `docs/sanitized-workflow-demo.md`
and relevant tests before changing DML or DDL behavior. Preserve opt-in
registration, structured targets, explicit confirmation where required,
metadata preflight, sanitized audit and no automatic retry after an unknown
outcome.

Do not run a mutation, enable a destructive option or alter database state
without explicit user and environment-owner authorization.
