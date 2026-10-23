# Sanitized DML agent workflow

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
