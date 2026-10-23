# Sanitized DML workflow

This example is intentionally synthetic. It contains no credentials, hostnames, internal identifiers, or production data.

1. Start the server with `MYSQL_DML_ENABLED=true` and credentials supplied by the process environment or a secret manager.
2. Discover the permitted schemas, tables, and columns with the five read-only tools.
3. Review the target object and the exact bounded operation with an operator.
4. Call one DML tool with a short reason:

```json
{
  "name": "insert_rows",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_records",
    "rows": [{ "label": "synthetic example" }],
    "reason": "Create the synthetic example record"
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
    "reason": "Correct the synthetic example label"
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
    "reason": "Remove the synthetic example record"
  }
}
```

The response includes an `operationId`, target, affected-row count, and sanitized outcome. `MYSQL_PERMISSION_DENIED` means MySQL rejected the operation; it does not mean the server can grant access. `MYSQL_DML_OUTCOME_UNKNOWN` means the request may have reached MySQL, so verify state before retrying. The server never retries automatically.

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

Before running it, provision `pre_provisioned_dml_fixture` in the isolated schema with an integer primary key named `id` and a non-null `label` column. The test removes its synthetic row even when a later operation fails. Never point it at production, shared, or sensitive data.
