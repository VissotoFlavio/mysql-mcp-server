# Changelog

## 0.18.0 - 2026-11-09

- [#80 — ddl: expose controlled `truncate_table` MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/80): separate destructive opt-in, target-bound metadata confirmation, foreign-key fail-closed preflight, sanitized audit/outcomes, stable TRUNCATE effects, and no automatic retry.

## 0.17.0 - 2026-11-09

- [#79 — feat: add controlled `drop_table`](https://github.com/VissotoFlavio/mysql-mcp-server/issues/79): separate destructive opt-in, target-bound metadata revision confirmation, fail-closed dependency preflight, sanitized audit/outcomes, post-execution verification, and no automatic retry.

## 0.16.0 - 2026-11-09

- [#78 — feat: add controlled `alter_table_drop_column`](https://github.com/VissotoFlavio/mysql-mcp-server/issues/78): separate strict opt-in and metadata-visibility attestation, exact `DROP_COLUMN` confirmation, fail-closed dependency preflight, sanitized audit/outcomes, post-execution verification, and no automatic retry guidance.

## 0.15.0 - 2026-11-08

- [#81 — feat: add controlled `create_schema`](https://github.com/VissotoFlavio/mysql-mcp-server/issues/81)

## 0.14.0 - 2026-11-08

- [#84 — feat: add controlled `drop_view`](https://github.com/VissotoFlavio/mysql-mcp-server/issues/84)

## 0.13.0 - 2026-11-08

- [#83 — feat: add controlled projection-only `create_view`](https://github.com/VissotoFlavio/mysql-mcp-server/issues/83)

## 0.12.0 - 2026-11-08

- [#76 — ddl: expose controlled alter_table_drop_foreign_key MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/76)

## 0.11.0 - 2026-11-06

- [#75 — ddl: expose controlled drop_index MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/75)

## 0.10.0 - 2026-11-06

- [#77 — ddl: expose controlled alter_table_modify_column MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/77)

## 0.9.0 - 2026-11-06

- [#73 — ddl: expose controlled rename_table MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/73)

## 0.8.0 - 2026-11-06

- [#72 — ddl: expose controlled alter_table_rename_column MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/72)

## 0.7.0 - 2026-11-06

- [#74 — ddl: expose controlled alter_table_add_foreign_key MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/74)

## 0.6.0 - 2026-11-06

- [#70 — ddl: expose controlled create_unique_index MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/70)

## 0.5.0 - 2026-11-06

- [#71 — ddl: expose controlled alter_table_add_column MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/71)

## 0.4.0 - 2026-11-06

- [#69 — ddl: expose controlled create_index MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/69)

## 0.3.0 - 2026-11-05

- [#66 — ci: generate an installable package candidate from a release pull request](https://github.com/VissotoFlavio/mysql-mcp-server/issues/66)

- [#64 — ci: publish a GitHub Release after a merged release branch](https://github.com/VissotoFlavio/mysql-mcp-server/issues/64)

- [#61 — test: support DDL integration with one simultaneous connection](https://github.com/VissotoFlavio/mysql-mcp-server/issues/61)

- [#54 — docs: document and validate the controlled CREATE TABLE workflow](https://github.com/VissotoFlavio/mysql-mcp-server/issues/54)

- [#53 — feat: expose controlled create_table MCP tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/53)

- [#52 — feat: add sanitized DDL auditing and outcomes](https://github.com/VissotoFlavio/mysql-mcp-server/issues/52)

- [#51 — feat: add capability-bound CREATE TABLE execution](https://github.com/VissotoFlavio/mysql-mcp-server/issues/51)

- [#50 — feat: validate structured CREATE TABLE specifications](https://github.com/VissotoFlavio/mysql-mcp-server/issues/50)
- [#49 — feat: add opt-in DDL feature configuration](https://github.com/VissotoFlavio/mysql-mcp-server/issues/49)

## 0.2.0 - 2026-10-23

- [#35 — docs: consolidate DML validation and sanitized workflow](https://github.com/VissotoFlavio/mysql-mcp-server/issues/35)

- [#34 — feat: implement bounded delete_rows tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/34)
- [#32 — feat: add bounded update_rows tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/32)
- [#33 — feat: add controlled insert_rows tool](https://github.com/VissotoFlavio/mysql-mcp-server/issues/33)
- [#31 — feat: add sanitized audit logging and safe errors](https://github.com/VissotoFlavio/mysql-mcp-server/issues/31)
- [#28 — feat: add structured filters with safe SQL generation](https://github.com/VissotoFlavio/mysql-mcp-server/issues/28)

## 0.1.0 - 2026-10-18

- [#2 — feat: add direct MySQL connection layer](https://github.com/VissotoFlavio/mysql-mcp-server/issues/2)
- [#3 — feat: list accessible schemas and tables](https://github.com/VissotoFlavio/mysql-mcp-server/issues/3)
- [#4 — feat: describe tables and columns](https://github.com/VissotoFlavio/mysql-mcp-server/issues/4)
- [#5 — feat: support parameterized read-only SELECT queries](https://github.com/VissotoFlavio/mysql-mcp-server/issues/5)
- [#6 — feat: add EXPLAIN query analysis](https://github.com/VissotoFlavio/mysql-mcp-server/issues/6)
- [#7 — security: enforce the read-only execution boundary](https://github.com/VissotoFlavio/mysql-mcp-server/issues/7)
- [#14 — ci: define application validation workflow](https://github.com/VissotoFlavio/mysql-mcp-server/issues/14)
- [#16 — docs: make README installation-ready and AI-agent-ready](https://github.com/VissotoFlavio/mysql-mcp-server/issues/16)
- [#18 — docs: explain value, use cases, security limits, and safe demo](https://github.com/VissotoFlavio/mysql-mcp-server/issues/18)
- [#20 — ci: open a branch-based master-to-develop backport pull request](https://github.com/VissotoFlavio/mysql-mcp-server/issues/20)
- [#26 — feat: add opt-in DML configuration flag](https://github.com/VissotoFlavio/mysql-mcp-server/issues/26)
- [#27 — feat: validate tables, columns, and keys before writes](https://github.com/VissotoFlavio/mysql-mcp-server/issues/27)
- [#29 — feat: add shared DML input validation and limits](https://github.com/VissotoFlavio/mysql-mcp-server/issues/29)
- [#30 — feat: create controlled internal DML execution path](https://github.com/VissotoFlavio/mysql-mcp-server/issues/30)
