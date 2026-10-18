# Sanitized MCP workflow demo

This public transcript demonstrates the supported MCP workflow with fictional, isolated data. The `demo_catalog` schema, `sample_records` table, values, and query-plan fields below are synthetic; they are not copied from a MySQL server. No credentials, hostnames, certificates, internal object names, or real query results are included.

The sequence is reproduced by the `runs the published sanitized MCP workflow` test in [`test/unit/sanitized-workflow-demo.test.ts`](../test/unit/sanitized-workflow-demo.test.ts). That test creates the real MCP application, connects an in-memory MCP client, and calls the five registered tools through MCP. Its database driver is a fixed in-memory fixture, so the demonstration cannot access a database or alter data.

After installing dependencies with `npm ci`, run the normal unit suite to reproduce it:

```bash
npm test
```

The transcript uses the fixture responses asserted by that test. A production session instead uses the local stdio setup in the [README](../README.md), a dedicated least-privilege account, and only non-sensitive data where appropriate.

## 1. Discover visible schemas

**Agent prompt:** "Which schemas can I inspect?"

```json
{
  "name": "list_accessible_schemas",
  "arguments": {}
}
```

```json
{
  "metadata": [{ "schemaName": "demo_catalog" }]
}
```

## 2. Discover tables and views in one permitted schema

**Agent prompt:** "What objects are available in `demo_catalog`?"

```json
{
  "name": "list_accessible_tables",
  "arguments": { "schema": "demo_catalog" }
}
```

```json
{
  "metadata": [
    {
      "schemaName": "demo_catalog",
      "tableName": "sample_records",
      "tableType": "BASE TABLE"
    }
  ]
}
```

## 3. Describe one accessible object

**Agent prompt:** "What columns and keys does `demo_catalog.sample_records` have?"

```json
{
  "name": "describe_table",
  "arguments": {
    "schema": "demo_catalog",
    "table": "sample_records"
  }
}
```

```json
{
  "table": {
    "schemaName": "demo_catalog",
    "tableName": "sample_records",
    "tableType": "BASE TABLE"
  },
  "columns": [
    {
      "columnName": "record_id",
      "dataType": "bigint",
      "isNullable": false,
      "columnKey": "PRI"
    },
    {
      "columnName": "created_at",
      "dataType": "datetime",
      "isNullable": false,
      "columnKey": ""
    }
  ]
}
```

## 4. Run a bounded read-only query

**Agent prompt:** "Show the two latest sample records, sorting ties by the primary key."

```json
{
  "name": "execute_read_only_query",
  "arguments": {
    "sql": "SELECT record_id, created_at FROM demo_catalog.sample_records ORDER BY created_at DESC, record_id DESC LIMIT 2",
    "parameters": []
  }
}
```

```json
{
  "columns": [
    { "name": "record_id", "type": "LONGLONG" },
    { "name": "created_at", "type": "DATETIME" }
  ],
  "rows": [
    { "record_id": 2, "created_at": "2026-01-02T00:00:00.000Z" },
    { "record_id": 1, "created_at": "2026-01-01T00:00:00.000Z" }
  ]
}
```

Those rows are fixture values only. The literal `LIMIT 2` bounds returned rows, but it does not prove that the database scanned only two rows or that the query has a low execution cost.

## 5. Inspect the plan for the same query

**Agent prompt:** "How would MySQL plan the bounded query before I rely on it?"

```json
{
  "name": "explain_read_only_query",
  "arguments": {
    "sql": "SELECT record_id, created_at FROM demo_catalog.sample_records ORDER BY created_at DESC, record_id DESC LIMIT 2",
    "parameters": []
  }
}
```

```json
{
  "columns": [
    { "name": "id", "type": "LONG" },
    { "name": "select_type", "type": "VAR_STRING" },
    { "name": "table", "type": "VAR_STRING" },
    { "name": "type", "type": "VAR_STRING" },
    { "name": "rows", "type": "LONGLONG" },
    { "name": "Extra", "type": "VAR_STRING" }
  ],
  "rows": [
    {
      "id": 1,
      "select_type": "SIMPLE",
      "table": "sample_records",
      "type": "ALL",
      "rows": "2",
      "Extra": "Using filesort"
    }
  ]
}
```

The plan fields and values are synthetic, so they are not performance evidence for any real database. In a real environment, use the plan to decide whether to refine the permitted query, keep a query timeout in place, and follow the operational safeguards in the README.
