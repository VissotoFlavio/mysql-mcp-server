# MySQL MCP Server

`mysql-mcp-server` is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for safe, bounded, read-only access to MySQL metadata, queries, and query plans. It runs only as a local stdio process: it does not expose an HTTP endpoint or listen on a network port.

Use it with a dedicated MySQL account that has only the minimum read permissions required. The server neither grants nor elevates database permissions.

## Why this exists

When a developer is investigating a legacy or unfamiliar MySQL database, an AI agent needs accurate context before it can help. Manually copying schema details into a conversation is slow, becomes stale, and can expose more information than necessary.

This server lets a locally connected agent inspect metadata visible to its configured account, run one bounded read-only query at a time, and request an `EXPLAIN` plan for that query. The agent can build context from permitted tool results instead of a manually maintained database dump. It does not infer relationships that the available schemas, tables, column metadata, query results, or plans do not expose.

## Use cases

Use the registered tools to turn focused natural-language questions into a read-only exploration workflow:

| Developer prompt                                                            | Tool                      | Example request                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| "Which schemas can I inspect with this account?"                            | `list_accessible_schemas` | List the schemas visible to the configured MySQL account.                                                                                       |
| "What tables and views are available in `example_catalog`?"                 | `list_accessible_tables`  | Send `{ "schema": "example_catalog" }`.                                                                                                         |
| "Describe the columns and keys in `example_catalog.sample_records`."        | `describe_table`          | Send `{ "schema": "example_catalog", "table": "sample_records" }`.                                                                              |
| "Show the five latest permitted records, breaking ties by the primary key." | `execute_read_only_query` | Send `SELECT record_id, created_at FROM example_catalog.sample_records ORDER BY created_at DESC, record_id DESC LIMIT 5` with `parameters: []`. |
| "Before running that bounded query, how will MySQL plan it?"                | `explain_read_only_query` | Send the same policy-approved `SELECT` and parameters; do not prepend `EXPLAIN`.                                                                |

The identifiers in these prompts are illustrative. Use only objects visible to the configured account, bind values through `parameters`, and include a literal `LIMIT` from 0 through 100 in every query. A prompt asking for the "latest" records must specify a deterministic `ORDER BY` and a literal limit, as in the example above.

## Sanitized workflow demo

The [sanitized MCP workflow transcript](docs/sanitized-workflow-demo.md) shows metadata discovery, object description, a bounded query, and plan inspection in sequence. It is backed by a reproducible in-memory MCP test that uses only synthetic data; no database connection, credential, hostname, certificate, internal identifier, or production query result is present.

## What you need

- Node.js 22 or later and npm.
- A reachable MySQL server and an account with the intended read access. The account's effective permissions determine the schemas, tables, and views that the tools can see.
- An MCP client that can launch a local stdio process. Consult that client's documentation for its configuration file and syntax; this project does not prescribe a particular client or vendor.
- A secure way to supply process environment variables. Do not put credentials, connection strings, or TLS material in source control, chat transcripts, or a client configuration file.

## Install, build, and start

The lockfile makes the dependency installation reproducible:

```bash
npm ci
npm run build
```

Copy the tracked blank-variable template to an untracked local file and fill it only on the machine or secret store that launches the server. The application reads its configuration from the process environment; Node 22 can load that local file with `--env-file`.

```bash
cp .env.example .env
node --env-file=.env dist/server.js
```

On PowerShell, use `Copy-Item .env.example .env` for the copy step. Never commit the resulting `.env` file. If a process supervisor or MCP client injects environment variables itself, start `node dist/server.js` instead.

The command above is a long-running stdio server. Its standard output is reserved exclusively for MCP protocol messages. Do not add `console.log` output, shell banners, log-forwarding wrappers, or package-manager status messages to stdout. Send operational logs to stderr. If a wrapper is unavoidable, use one that is silent on stdout; for the provided script, that is `npm --silent start` with the environment already supplied externally.

## Runtime configuration

All configuration is validated at startup. The values below are names and constraints, not sample credentials. Keep the values in the launching process or a local secret-managed file.

| Variable                        | Required | Constraint or default                                                              |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `MYSQL_HOST`                    | Yes      | Hostname or IPv4 address only; no scheme, port, or path.                           |
| `MYSQL_PORT`                    | No       | Integer 1–65535; defaults to 3306.                                                 |
| `MYSQL_DATABASE`                | Yes      | Non-empty identifier up to 64 characters; no NUL or line breaks.                   |
| `MYSQL_USER`                    | Yes      | Non-empty identifier up to 64 characters; no NUL or line breaks.                   |
| `MYSQL_PASSWORD`                | Yes      | Non-empty value.                                                                   |
| `MYSQL_POOL_LIMIT`              | No       | Integer 1–2; defaults to 2.                                                        |
| `MYSQL_QUEUE_LIMIT`             | No       | Integer 1–100; defaults to 10.                                                     |
| `MYSQL_CONNECT_TIMEOUT_MS`      | No       | Integer 100–60000; defaults to 5000.                                               |
| `MYSQL_QUERY_TIMEOUT_MS`        | No       | Integer 100–60000; defaults to 30000.                                              |
| `MYSQL_IDLE_TIMEOUT_MS`         | No       | Integer 1000–3600000; defaults to 60000.                                           |
| `MYSQL_TLS`                     | No       | `true` enables TLS; defaults to `false`.                                           |
| `MYSQL_TLS_REJECT_UNAUTHORIZED` | No       | May only be `true`; peer verification cannot be disabled.                          |
| `MYSQL_TLS_CA_FILE`             | No       | Path to externally managed CA material; requires `MYSQL_TLS=true`.                 |
| `MYSQL_TLS_CERT_FILE`           | No       | Path to externally managed client certificate material; requires `MYSQL_TLS=true`. |
| `MYSQL_TLS_KEY_FILE`            | No       | Path to externally managed client key material; requires `MYSQL_TLS=true`.         |

TLS files are read only after TLS is explicitly enabled. Startup and tool errors are intentionally safe: they guide an operator to check configuration, connectivity, parameters, or permissions without returning credentials, certificate contents, or raw database errors.

## Configure an MCP client safely

Configure the client to launch the built server as a local child process. The generic process contract is:

- executable: `node`
- arguments: `--env-file=/absolute/path/to/mysql-mcp-server/.env` followed by `/absolute/path/to/mysql-mcp-server/dist/server.js`
- transport: stdio

Those paths are placeholders, not a client-specific configuration format. Use the syntax required by the chosen client, and keep secrets out of that configuration. Prefer the client's secret/environment injection mechanism when it has one; then omit `--env-file` and supply the required `MYSQL_*` values to the child process. The client must leave the child's stdout unmodified because it carries MCP messages.

## Tool contract

The server registers exactly these five read-only tools. Successful calls include `structuredContent` and a JSON text representation of the same result, so integrations can consume the documented object shapes. Metadata is deterministically ordered; query row order remains the order returned by MySQL, so clients should use SQL ordering when they require it.

| Tool                      | Input                                                                                                                                                                                        | Structured result and limits                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_accessible_schemas` | No input.                                                                                                                                                                                    | `{ metadata: [{ schemaName }] }`; at most 100 schemas, ordered by schema name ascending.                                                                                                                                                    |
| `list_accessible_tables`  | Exactly `{ schema }`, where `schema` is a non-empty string of at most 64 characters.                                                                                                         | `{ metadata: [{ schemaName, tableName, tableType }] }`; at most 100 tables or views in that schema, ordered by schema then table name ascending.                                                                                            |
| `describe_table`          | Exactly `{ schema, table }`; each is a non-empty identifier of at most 64 characters and has no control characters.                                                                          | `{ table: { schemaName, tableName, tableType }, columns: [{ columnName, dataType, isNullable, columnKey }] }`; describes one accessible table or view and returns at most 100 columns in ordinal position order.                            |
| `execute_read_only_query` | Exactly `{ sql, parameters }`. `sql` is 1–10000 characters; `parameters` has at most 100 JSON scalars (`string`, finite `number`, `boolean`, or `null`), with strings up to 8192 characters. | `{ columns: [{ name, type }], rows: [...] }`; at most 100 columns, 100 rows, and 512 KiB of serialized JSON. Values are JSON-compatible; returned big integers are strings, dates are ISO timestamps, and binary values are base64 strings. |
| `explain_read_only_query` | The same input and validation as `execute_read_only_query`. Send the SELECT or CTE itself, not an `EXPLAIN` statement.                                                                       | The same bounded `{ columns, rows }` shape, containing the MySQL `EXPLAIN` result. It uses `EXPLAIN`, never `EXPLAIN ANALYZE`.                                                                                                              |

For both query tools, the SQL must be one policy-approved `SELECT` or read-only CTE and must contain a literal `LIMIT` from 0 through 100. Bind values through `parameters`; a parameter cannot replace the required literal `LIMIT`. Invalid SQL, oversized results, timeouts, unavailable objects, and connection failures return a safe MCP error result rather than an unfiltered driver error.

## Read-only boundary

This is not a general SQL administration channel. The query and plan tools reject writes, DDL, administrative statements, multiple statements, unsafe `SELECT` forms, locking reads, and `EXPLAIN ANALYZE`. Multiple statements are also disabled in the MySQL driver. Metadata operations query `information_schema` only. No tool provides data mutation, schema changes, permission changes, unbounded export, HTTP hosting, or credential management.

## Security considerations

The read-only policy is defense in depth. It is not a replacement for authorization, data classification, network isolation, auditing, monitoring, or an access-review process. The database account remains the authority for what the server can see.

An allowed `SELECT` can still reveal sensitive information and consume database resources. The required `LIMIT` bounds returned rows, not the rows that MySQL must scan or the query's execution cost. This server does not provide data masking, relationship inference, query-cost enforcement, or a guarantee that a workload is suitable for production.

Operate it with the following safeguards:

- Use a dedicated least-privilege account that can reach only the intended schemas and objects.
- Restrict database and network access to the local client and approved database endpoints.
- Prefer non-production or masked data when that is appropriate for the task.
- Audit and monitor the account and database activity.
- Configure a practical `MYSQL_QUERY_TIMEOUT_MS` for the environment and still review query shape before running it.

## Validation

Run the local checks that do not require a database or credentials:

```bash
npm run format:check
npm run lint
npm test
```

Integration tests are opt-in and are not part of the normal local validation. They acquire a connection and perform read-only metadata discovery; they do not mutate data. With required MySQL configuration supplied externally, set `MYSQL_INTEGRATION_TEST` to `true`. Set `MYSQL_INTEGRATION_TABLE` to one accessible table or view, and set `MYSQL_INTEGRATION_SCHEMA` only when it differs from `MYSQL_DATABASE`, then run:

```bash
npm run test:integration
```

For PowerShell, set the opt-in flag for the current session with `$env:MYSQL_INTEGRATION_TEST = 'true'`. In POSIX shells, prefix the command with `MYSQL_INTEGRATION_TEST=true`.
