---
name: mysql-query-boundary-change
description: Change MySQL MCP read-only query, metadata, output-limit, or sanitization behavior. Use when modifying discovery, describe, SELECT, EXPLAIN, parameter, or result contracts.
---

# MySQL query boundary change

Read `README.md`, `docs/configuration.md`, the applicable tool contract and
tests before changing read-only behavior. Preserve a single policy-approved
read-only statement, literal LIMIT requirements, bounded result shape,
parameter binding and sanitized errors.

Do not use a development change as authority to connect to a database or query
real data. Update the canonical document and focused tests with the
implementation.
