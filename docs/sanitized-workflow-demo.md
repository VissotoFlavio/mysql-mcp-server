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

### Controlled index creation

`create_index` is also advertised only with `MYSQL_DDL_ENABLED=true`. After discovering and confirming the target table and columns, obtain explicit operator confirmation for the exact `{ schema, table, index, columns, reason }` request. It creates only a named non-unique B-tree over existing visible, non-generated columns; arbitrary SQL, prefixes, expressions, unique/full-text/spatial/functional indexes, algorithm/lock options, and index changes or removal remain unavailable.

The MySQL account needs narrowly scoped `SELECT` on the target table for metadata preflight plus `INDEX` on the target schema for this operation. A success is not the end of the workflow: inspect metadata to confirm the named index. For `MYSQL_DDL_OUTCOME_UNKNOWN`, verify state before a new operator-approved request; never retry automatically. Permission, duplicate-index, lock/deadlock, and metadata failures return sanitized results and never authorize a grant or broader DDL.

### Controlled unique index creation

`create_unique_index` uses the same exact structured request and is advertised only with `MYSQL_DDL_ENABLED=true`. Obtain explicit confirmation because it adds a persistent integrity constraint. The preflight checks the base table, visible non-generated columns, index name, primary/equivalent unique keys, and only the existence of a fully non-NULL duplicate tuple; no tuple values are returned or audited. Use narrowly scoped `SELECT` on the target table for metadata and duplicate preflight plus minimum `INDEX` privilege, verify the named index after success, and after an indeterminate outcome verify state and wait for renewed operator direction rather than retrying.

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

The DDL integration test also changes schema: it creates a dedicated test table via `create_table`, seeds only that table through `insert_rows`, verifies it through MCP metadata, creates and verifies non-unique and unique indexes, verifies a duplicate-data rejection for the unique index, adds a nullable column, then drops that table (and therefore its indexes) during cleanup. It needs narrowly scoped `SELECT`, plus `CREATE`, `INSERT`, `INDEX`, `ALTER`, and `DROP` on the isolated schema. It remains skipped unless all of these values are explicitly supplied:

```powershell
$env:MYSQL_INTEGRATION_TEST = 'true'
$env:MYSQL_DDL_INTEGRATION_TEST = 'true'
$env:MYSQL_DML_ENABLED = 'true'
$env:MYSQL_DDL_ENABLED = 'true'
$env:MYSQL_DDL_INTEGRATION_CONFIRM = 'isolated-database-schema'
$env:MYSQL_DDL_INTEGRATION_TABLE = 'mcp_ddl_test_synthetic'
npm run test:integration
```

The table name must begin with `mcp_ddl_test_`; this guard and the separate confirmation fail closed. Do not provide those values, or run the test, without explicit authorization to mutate that isolated schema.
