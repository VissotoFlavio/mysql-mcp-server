# Sanitized controlled-write agent workflow

This example is intentionally synthetic. It contains no credentials, hostnames, internal identifiers, or production data.

1. Start the server with `MYSQL_DML_ENABLED=true` and credentials supplied by the process environment or a secret manager.
2. Confirm that the MCP session advertises the DML tool to use. If it does not, DML is disabled and the agent must not substitute arbitrary SQL.
3. Discover the permitted schemas, tables, and columns with the five read-only tools. The configured account's MySQL permissions, not MCP discovery, remain the authority for whether a write will succeed.
4. Present the schema, table, values, filters, limit, and short audit reason to an operator. Execute only after the user has requested or confirmed that exact bounded change.
5. Call one DML tool with the confirmed reason:

```json
{
  "name": "insert_rows",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_records",
    "rows": [{ "label": "synthetic example" }],
    "reason": "Create the example record"
  }
}
```

```json
{
  "name": "update_rows",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_records",
    "values": { "label": "updated synthetic example" },
    "filters": [{ "column": "record_id", "operator": "eq", "value": 1 }],
    "limit": 1,
    "reason": "Correct the example label"
  }
}
```

```json
{
  "name": "delete_rows",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_records",
    "filters": [{ "column": "record_id", "operator": "eq", "value": 1 }],
    "limit": 1,
    "reason": "Remove the example record"
  }
}
```

Successful DML results always include `operation`, `operationId`, and `target`. `insert_rows` also returns `affectedRows`, `insertId`, and `warnings`; `update_rows` returns `matchedRows`, `affectedRows`, `changedRows`, and `warningCount`; `delete_rows` returns `affectedRows` and `warningCount`. A zero row count is a result to report, not evidence that the intended record exists or changed.

After a known successful write, use a bounded read-only query when practical to verify the expected state. `MYSQL_PERMISSION_DENIED` means MySQL rejected the operation; it does not mean the server can grant access. `MYSQL_DML_OUTCOME_UNKNOWN` or `retryAdvice: "VERIFY_STATE_BEFORE_RETRYING"` means the request may have reached MySQL, so verify the state with a read-only query and obtain operator direction before another write. The server never retries automatically.

The MCP layer validates identifiers, columns, filters, bounds, and payloads. MySQL remains the authorization and constraint authority. There is no local table allowlist and no separate DML credential. The configured account must have only the permissions appropriate for the enabled workflow.

## Controlled DDL workflow

### Controlled schema creation

`create_schema` is advertised only when both `MYSQL_DDL_ENABLED=true` and `MYSQL_DDL_CREATE_SCHEMA_ENABLED=true`. Obtain explicit confirmation for exactly `{ schema, charset?, collation?, reason }`; the target must be absent and may differ from `MYSQL_DATABASE`, which remains the connection context.

```json
{
  "name": "create_schema",
  "arguments": {
    "schema": "mcp_ddl_test_catalog",
    "charset": "utf8mb4",
    "collation": "utf8mb4_0900_ai_ci",
    "reason": "Create an isolated integration catalog"
  }
}
```

Only the internally built one-statement `CREATE SCHEMA` form is available. `IF NOT EXISTS`, SQL, expressions, quoted identifiers, tables, grants, users, roles, and arbitrary options are rejected. A bounded `information_schema.SCHEMATA` absence preflight runs before capability-bound DDL execution. The account needs metadata visibility plus `CREATE` privilege covering the target database; depending on the server's grant setup, that may be a global or database-level grant, so confirm the exact scope with the DBA and do not grant `CREATE USER`, `GRANT OPTION`, or broader administrative privileges. Success returns only sanitized target metadata, operation ID, and warnings. Conflict, permission, metadata, structural, lock/deadlock, and indeterminate outcomes are sanitized; verify state before a new operator-approved request after an indeterminate outcome and never retry automatically. After success, verify the schema with discovery and remove it only through an explicitly confirmed, isolated cleanup workflow.

`create_table` is advertised only when `MYSQL_DDL_ENABLED=true`. Its presence is a capability boundary, not blanket permission to change a schema. Before calling it, discover the accessible schema, state the exact structured definition and audit reason, and obtain the operator's explicit confirmation for that specific table.

```json
{
  "name": "create_table",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_events",
    "columns": [
      {
        "name": "event_id",
        "type": { "kind": "integer", "integerType": "bigint", "unsigned": true },
        "nullable": false,
        "autoIncrement": true
      },
      {
        "name": "label",
        "type": { "kind": "varchar", "length": 255 },
        "nullable": false
      }
    ],
    "primaryKey": ["event_id"],
    "reason": "Create the synthetic event table"
  }
}
```

A successful response contains only `operation`, `operationId`, `target`, and `warnings`. It does not echo SQL or the full table definition. If the safe result is `MYSQL_DDL_OUTCOME_UNKNOWN` or returns `retryAdvice: "VERIFY_STATE_BEFORE_RETRYING"`, verify whether the synthetic table exists with `list_accessible_tables` or `describe_table`, report the result, and wait for operator direction. Do not retry. Permission, existing-table, lock/deadlock, and structural outcomes are also reported without raw MySQL text; they do not authorize grants, arbitrary DDL, or an altered retry.

### Controlled view creation

`create_view` is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit confirmation for exactly `{ schema, view, definition: { table, columns }, reason }`. It creates only a same-schema `SQL SECURITY INVOKER` view containing a projection of distinct named columns from one existing base table. It does not accept SQL strings, expressions, aliases, joins, filters, ordering, parameters, CTEs, options, a different source schema, `DEFINER`, or any privilege-elevating clause.

The bounded preflight confirms the target is absent, the source is an accessible base table, and every selected column is visible; it does not return driver text or values. The account needs `CREATE VIEW` on the target schema and narrowly scoped actual `SELECT` on every projected source table/column; these data privileges are separate from metadata preflight. A view is persistent and can expose projected data to future readers, so confirm its intended audience, dependencies, lifecycle, and explicit cleanup plan. Success returns only the target and source relation metadata, with no SQL or reason. Permission, conflict, metadata, lock/deadlock, structure, and indeterminate outcomes are sanitized. After an indeterminate result, inspect metadata and wait for a new operator-approved request; never retry automatically. The server never removes a view automatically.

### Controlled view removal

`drop_view` is advertised only with `MYSQL_DDL_ENABLED=true`; set `MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE=true` only when the account can see all possible dependent views and referenced objects in the relevant schemas. Obtain explicit confirmation for exactly `{ schema, view, reason, confirmation: "DROP_VIEW" }` after reviewing the view's consumers. It accepts one existing `VIEW` only and emits the canonical `DROP VIEW` form internally; SQL, `IF EXISTS`, `CASCADE`, and multiple targets are unavailable.

The preflight checks `information_schema.TABLES` for the exact view and `information_schema.VIEW_TABLE_USAGE` for known dependent views. MySQL exposes only metadata for objects on which the account has privileges, so the explicit metadata-completeness flag is required and must be backed by an account with visibility across every relevant schema; without it the tool rejects the request before any DDL. `VIEW_TABLE_USAGE` is available from MySQL 8.0.13; older servers fail closed. Any known dependent view, malformed metadata, or unavailable dependency metadata is rejected before execution; no dependent object is removed automatically. The account needs metadata `SELECT` across relevant views/tables and `DROP` on the target view. Success verifies the view is absent through discovery and returns only the target and operation metadata. The preflight is not a lock against concurrent DDL, so run the operation during a controlled maintenance window and verify consumers afterward. Permission, type, metadata, structure, lock/deadlock, and indeterminate outcomes are sanitized; never retry an indeterminate result without a new operator decision.

### Controlled schema removal

`drop_schema` is advertised only when `MYSQL_DDL_ENABLED=true`, `MYSQL_DDL_DROP_SCHEMA_ENABLED=true`, and `MYSQL_DDL_DROP_SCHEMA_ALLOWLIST` contains one or more exact disposable schema names. The allowlist is a policy boundary, never a replacement for MySQL privileges, and it must not contain `MYSQL_DATABASE` or a protected system schema. The input always requires exactly `{ schema, reason }`; omit `confirmation` for the first call to receive a bounded, sanitized impact response. The schema must contain only visible InnoDB base tables, each with a durable `TABLE_ID`; empty schemas and schemas with views, routines, events, or triggers fail closed before confirmation.

The preflight reports only bounded base-table names and counts; views, routines, events, and triggers are unsupported and rejected rather than returned in a successful impact response. It returns a short-lived `DROP_SCHEMA:<metadataRevision>` confirmation bound to the target and current metadata fingerprint, which includes internal base-table creation identities and durable table IDs. Creation timestamps alone are not durable identity. A changed base table or durable table ID fails closed; an identical external drop/recreate whose metadata identity is unchanged is not provably detectable. The token is not a cross-session lock: if external DDL may have occurred, discard it and obtain a fresh operator decision, verify a tested backup and recovery path, review consumers and object ownership, and schedule a controlled maintenance window. The execution request must repeat the exact schema and reason with that confirmation; the server rechecks metadata, consumes the token once, emits only canonical `DROP SCHEMA schema`, verifies the schema is absent, and never accepts `IF EXISTS`, `CASCADE`, multiple targets, SQL, grants, implicit cleanup, or automatic retry. Independently post-check absence and recovery after the operation. Permission, metadata, structure, lock/deadlock, and indeterminate outcomes are safe `MYSQL_DDL_*` results; after an unknown outcome, inspect state and wait for a new operator-approved request.

### Controlled table removal

`drop_table` is advertised only when `MYSQL_DDL_ENABLED=true`, `MYSQL_DDL_DROP_TABLE_ENABLED=true`, and `MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE=true`. First call `describe_table` for the exact target. Its short-lived opaque `metadataRevision` is bound to the target metadata and table creation identity; pass it once as `confirmation: "DROP_TABLE:<metadataRevision>"` with exactly `{ schema, table, reason, confirmation }`. A changed or recreated table produces a different attestation and fails closed before DDL.

The preflight accepts one existing `BASE TABLE` only and rejects malformed or unavailable metadata, dependent views from `information_schema.VIEW_TABLE_USAGE`, foreign-key relationships, and triggers. The metadata-completeness flag is an operator attestation that the configured account can see all relevant dependency metadata; the account needs metadata `SELECT` plus `DROP` on the target table. The tool emits only canonical internal `DROP TABLE` for that one target: `IF EXISTS`, `CASCADE`, SQL, schemas, views, multiple tables, backup, and recovery are unavailable. Dropping a table is irreversible; take and verify backups externally before confirmation, use a maintenance window, verify absence through `describe_table` or discovery afterward, and never automatically retry permission, lock/deadlock, structural, or indeterminate outcomes.

### Controlled table truncation

`truncate_table` is advertised only when `MYSQL_DDL_ENABLED=true`, `MYSQL_DDL_TRUNCATE_TABLE_ENABLED=true`, and `MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE=true`. Call `describe_table` for one exact base table, then obtain confirmation for `{ schema, table, reason, confirmation: "TRUNCATE_TABLE:<metadataRevision>" }`. The short-lived revision is target-bound and consumed once before submission. Preflight fails closed on malformed or unavailable metadata and any foreign-key relationship involving the table; it emits only canonical `TRUNCATE TABLE schema.table`, never `DELETE`, filters, options, SQL, or multiple targets.

The sanitized result contains `operation`, `operationId`, `target`, `warnings`, and stable `effects`: `AUTO_INCREMENT_RESET`, `IMPLICIT_COMMIT_NO_ROLLBACK`, and `METADATA_LOCKS`. MySQL permission, structure, lock/deadlock, and uncertain outcomes use safe `MYSQL_DDL_*` codes; after `MYSQL_DDL_OUTCOME_UNKNOWN`, verify state before retrying and never retry automatically. The account needs complete foreign-key metadata visibility plus the minimum `DROP` privilege required by MySQL for `TRUNCATE TABLE`.

### Controlled index creation

`create_index` is also advertised only with `MYSQL_DDL_ENABLED=true`. After discovering and confirming the target table and columns, obtain explicit operator confirmation for the exact `{ schema, table, index, columns, reason }` request. It creates only a named non-unique B-tree over existing visible, non-generated columns; arbitrary SQL, prefixes, expressions, unique/full-text/spatial/functional indexes, algorithm/lock options, and index changes or removal remain unavailable.

The MySQL account needs narrowly scoped `SELECT` on the target table for metadata preflight plus `INDEX` on the target schema for this operation. A success is not the end of the workflow: inspect metadata to confirm the named index. For `MYSQL_DDL_OUTCOME_UNKNOWN`, verify state before a new operator-approved request; never retry automatically. Permission, duplicate-index, lock/deadlock, and metadata failures return sanitized results and never authorize a grant or broader DDL.

### Controlled unique index creation

`create_unique_index` uses the same exact structured request and is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit confirmation because it adds a persistent integrity constraint. The preflight checks the base table, visible non-generated columns, index name, primary/equivalent unique keys, and only the existence of a fully non-NULL duplicate tuple; no tuple values are returned or audited. Use narrowly scoped `SELECT` on the target table for metadata and duplicate preflight plus minimum `INDEX` privilege, verify the named index after success, and after an indeterminate outcome verify state and wait for renewed operator direction rather than retrying.

### Controlled index removal

`drop_index` is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit operator confirmation for exactly `{ schema, table, index, reason }`. The preflight accepts only an explicitly named visible secondary, non-unique, ascending B-tree whose entries are ordinary whole columns. It rejects `PRIMARY`, unique or unique-equivalent definitions, indexes supporting a foreign key, functional, prefix, descending, non-B-tree, invisible, and other unsupported definitions, as well as views and invalid metadata. It never removes a constraint or another index implicitly and never accepts SQL, expressions, or options.

The account needs narrowly scoped metadata `SELECT` plus the minimum `INDEX` privilege required to remove the named index. The server emits only its internally generated canonical statement, records a sanitized audit event with an operation ID, and verifies after execution that the named index is absent. Permission, structural, lock/deadlock, metadata, and indeterminate outcomes are sanitized; an indeterminate or failed post-verification must be checked through read-only metadata before any newly approved request, and the operation is never retried automatically.

```json
{
  "name": "drop_index",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_events",
    "index": "sample_events_label_idx",
    "reason": "Remove the redundant label lookup index"
  }
}
```

## Opt-in integration testing

Integration tests are intentionally excluded from normal validation because DML changes data. Run them only against an isolated disposable database after explicit authorization, with credentials supplied externally:

```powershell
$env:MYSQL_INTEGRATION_TEST = 'true'
$env:MYSQL_DML_INTEGRATION_TEST = 'true'
$env:MYSQL_DML_ENABLED = 'true'
$env:MYSQL_DML_INTEGRATION_CONFIRM = 'isolated-database'
$env:MYSQL_DML_INTEGRATION_TABLE = 'pre_provisioned_dml_fixture'
npm run test:integration
```

The published transcript is reproduced by [`test/unit/sanitized-workflow-demo.test.ts`](../test/unit/sanitized-workflow-demo.test.ts); run `npm test` after installing dependencies. Before running the integration test, provision `pre_provisioned_dml_fixture` in the isolated schema with an integer primary key named `id` and a non-null `label` column. The test removes its synthetic row even when a later operation fails. Never point it at production, shared, or sensitive data.

The DDL integration test also changes schema: it creates a dedicated test table via `create_table`, creates a projection-only test view, seeds only that table through `insert_rows`, verifies it through MCP metadata, creates and verifies non-unique and unique indexes, exercises `drop_index` for the removable index and its protected-index rejections, verifies a duplicate-data rejection for the unique index, adds a nullable column, then drops the view before that table (and therefore its remaining indexes) during cleanup. It needs narrowly scoped actual `SELECT` on projected source columns, plus `CREATE`, `CREATE VIEW`, `INSERT`, `INDEX`, `ALTER`, and `DROP` on the isolated schema. It remains skipped unless all of these values are explicitly supplied:

```powershell
$env:MYSQL_INTEGRATION_TEST = 'true'
$env:MYSQL_DDL_INTEGRATION_TEST = 'true'
$env:MYSQL_DML_ENABLED = 'true'
$env:MYSQL_DDL_ENABLED = 'true'
$env:MYSQL_DDL_DROP_VIEW_METADATA_COMPLETE = 'true'
$env:MYSQL_DDL_DROP_COLUMN_ENABLED = 'true'
$env:MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE = 'true'
$env:MYSQL_DDL_DROP_TABLE_ENABLED = 'true'
$env:MYSQL_DDL_DROP_TABLE_METADATA_COMPLETE = 'true'
$env:MYSQL_DDL_INTEGRATION_CONFIRM = 'isolated-database-schema'
$env:MYSQL_DDL_INTEGRATION_TABLE = 'mcp_ddl_test_synthetic'
$env:MYSQL_DDL_DROP_TABLE_INTEGRATION_TABLE = 'mcp_ddl_test_drop_table_synthetic'
npm run test:integration
```

Each temporary table name must begin with `mcp_ddl_test_`; these guards and the separate confirmation fail closed. The focused drop-table contract uses `MYSQL_DDL_DROP_TABLE_INTEGRATION_TABLE` and is skipped when it is unset. The test drops only the explicitly confirmed disposable table and its derived cleanup objects, plus the explicitly confirmed `renamed_note` column from that table. Do not provide those values, or run the test, without explicit authorization to mutate that isolated schema.

The focused `truncate_table` integration owner is skipped unless `MYSQL_DDL_TRUNCATE_TABLE_ENABLED=true`, `MYSQL_DDL_TRUNCATE_TABLE_METADATA_COMPLETE=true`, `MYSQL_DDL_INTEGRATION_CONFIRM=isolated-database-schema`, and a separate `MYSQL_DDL_TRUNCATE_TABLE_INTEGRATION_TABLE` beginning with `mcp_ddl_test_` are supplied together with the normal DDL/DML integration authorization. It creates one disposable table, inserts one synthetic row, truncates it through MCP, verifies zero rows and the auto-increment reset, and removes only that owned table. Do not provide these values or run it without explicit authorization to mutate that isolated schema.

The separate `create_schema` integration owner is skipped unless it receives a separate explicit authorization: `MYSQL_DDL_CREATE_SCHEMA_INTEGRATION_TEST=true`, `MYSQL_DDL_CREATE_SCHEMA_ENABLED=true`, `MYSQL_DDL_CREATE_SCHEMA_INTEGRATION_CONFIRM=isolated-schema-create-drop`, and the derived target begins with `mcp_ddl_test_`. The generic DDL table confirmation above intentionally does not activate it. This test creates and drops one schema distinct from `MYSQL_DATABASE` and removes only that exact derived target during cleanup. Do not provide these values or run it without explicit authorization for that isolated schema lifecycle.

The separate `drop_schema` integration owner is skipped unless `MYSQL_DDL_DROP_SCHEMA_INTEGRATION_TEST=true`, `MYSQL_DDL_DROP_SCHEMA_INTEGRATION_CONFIRM=isolated-schema-create-drop`, a dedicated `MYSQL_DDL_DROP_SCHEMA_INTEGRATION_SCHEMA` beginning with `mcp_ddl_test_`, and an exact allowlist containing only that disposable target are supplied with the normal DDL authorization. It creates one disposable schema, preflights and drops only that target, verifies absence, and is never part of ordinary validation. Do not enable it for `MYSQL_DATABASE` or a shared schema.

The rename integration contract is a separate owner in [`test/integration/rename-table.integration.test.ts`](../test/integration/rename-table.integration.test.ts). It derives a source ending in `_rt` and a destination ending in `_rt_r` from `MYSQL_DDL_INTEGRATION_TABLE`, first verifies both names are absent, then creates, renames, describes, and cleans up only those names. It runs under the same opt-in and isolated-schema guard, and is included by `npm run test:integration`; never point either DDL fixture at shared or production data.

### Controlled foreign-key creation

`alter_table_add_foreign_key` is advertised only with `MYSQL_DDL_ENABLED=true`. Before calling it, discover both base tables and explicitly confirm `{ schema, table, constraint, columns, referencedTable, referencedColumns, onDelete, onUpdate, reason }` with the operator. The tool accepts one intra-schema foreign key with 1–16 distinct ordered column pairs. Both actions are mandatory and restricted to `RESTRICT` or `NO ACTION`; it never infers `CASCADE`, creates indexes, accepts expressions or SQL, or references another schema.

The preflight verifies both base tables use InnoDB, the constraint is new, pairs are compatible, ordered supporting indexes already exist, and no orphan rows exist. It returns no values or raw metadata. A dedicated account needs only metadata/data-preflight `SELECT`, `ALTER` on the child table, and `REFERENCES` on the parent table for this operation. The operation can acquire metadata locks and concurrent writes or DDL can invalidate a successful preflight, so run it only after explicit confirmation and during an appropriate maintenance window. On `MYSQL_DDL_OUTCOME_UNKNOWN`, use metadata to verify whether the named constraint exists before seeking a new operator decision; never retry automatically.

### Controlled foreign-key removal

`alter_table_drop_foreign_key` is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit confirmation for exactly `{ schema, table, constraint, reason }`. The preflight confirms the named object is a foreign key on the requested base table; the canonical operation removes only that constraint and preserves its supporting index. Use metadata `SELECT` plus `ALTER` on the target table, review application dependencies on the relationship, verify the constraint is absent and the index remains, and never retry an indeterminate result.

### Controlled column modification

`alter_table_modify_column` is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit confirmation for exactly `{ schema, table, column, definition, reason }`, where `definition.name` must equal `column` and the remaining fields are the complete structured target definition. The first version permits only same-family widening: signedness-preserving integer widening, greater DECIMAL precision with the same scale, greater CHAR/VARCHAR length of the same kind, greater fractional-seconds precision of the same temporal kind, or changing `NOT NULL` to `NULL`. It rejects narrowing, signedness changes, type-family changes, renames, multiple columns, generated or invisible columns, defaults not represented by the contract, foreign-key dependencies, unsupported index forms, and arbitrary SQL.

The preflight reads bounded `information_schema` metadata and does not return column values. Existing B-tree index dependencies may require an index or table rebuild and metadata locks; functional/unsupported indexes, CHECK constraints, and foreign-key dependencies (including references from another schema) are rejected so both sides cannot become type-incompatible. Text widening preserves the current character set and collation in the generated statement. Primary-key columns cannot be made nullable. Use only metadata `SELECT` and `ALTER` on the target table. After success, the server verifies the resulting type, nullability, and preserved text settings; clients should also verify through `describe_table` or another permitted metadata read. A lock timeout, deadlock, structural failure, permission error, or `MYSQL_DDL_OUTCOME_UNKNOWN` remains sanitized; verify state before any new operator-approved request and never retry automatically.

### Controlled column removal

`alter_table_drop_column` is advertised only when `MYSQL_DDL_ENABLED=true`, the separate strict `MYSQL_DDL_DROP_COLUMN_ENABLED=true` opt-in, and the explicit `MYSQL_DDL_DROP_COLUMN_METADATA_COMPLETE=true` metadata visibility attestation are enabled. Obtain explicit confirmation for exactly `{ schema, table, column, reason, confirmation: "DROP_COLUMN" }`. The operation accepts one existing base-table column only; generated columns and columns involved in a primary key, any index/statistics entry, local or referenced foreign key, table constraint or CHECK, or known `information_schema.VIEW_TABLE_USAGE` dependency are rejected. SQL, expressions, options, multiple columns, cascades, and bypasses are unavailable, and no dependency is removed or rebuilt automatically.

The account needs metadata `SELECT` visibility plus `ALTER` on the target table. The preflight fails closed if any required metadata is missing, malformed, or incomplete, and the result is verified by confirming the column is absent after execution. Permission, structural, lock-timeout, deadlock, and indeterminate outcomes are sanitized; after an indeterminate result, verify state before a new operator-approved request and never retry automatically. The preflight is not a lock against concurrent DDL/DML, so use a controlled maintenance window.

### Controlled table rename

`rename_table` is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit operator confirmation for exactly `{ schema, table, newTable, reason }`. It accepts one unquoted source and destination identifier in the same schema, requires the source to be a `BASE TABLE`, requires the destination to be absent, and emits only the internally generated `RENAME TABLE` form.

MySQL requires `ALTER` and `DROP` on the source plus `CREATE` and `INSERT` on the destination; metadata preflight needs `SELECT` on `information_schema`. Review application code, jobs, views, reports, integrations, foreign-key dependencies, and table-specific permissions before the change. MySQL can update foreign-key references and internally generated constraint names, but grants specific to the old table name do not migrate. Verify that the source is absent and the destination is present with `describe_table` after success. Permission, metadata, lock/deadlock, and indeterminate outcomes are sanitized; never auto-retry an indeterminate result.

### Controlled column rename

`alter_table_rename_column` is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit operator confirmation for exactly `{ schema, table, column, newColumn, reason }`. It accepts one unquoted source and destination identifier, checks that the target is a base table, the source exists, and the destination is absent, then emits only the internally generated `ALTER TABLE ... RENAME COLUMN ... TO ...` form.

Use narrowly scoped metadata `SELECT` and `ALTER` privileges. The preflight does not enumerate or rewrite dependencies: MySQL is authoritative for preserving or rejecting indexes and constraints, while code, views, saved queries, reports, and integrations can still reference the old name. Verify the new column and its type/nullability with `describe_table`, and inspect any affected indexes or constraints through metadata before considering the workflow complete. Permission, metadata, lock/deadlock, and indeterminate outcomes are sanitized; never auto-retry, and verify state before a new operator-approved request after an indeterminate result. The opt-in DDL integration test performs this post-rename `describe_table` verification on its temporary table.
