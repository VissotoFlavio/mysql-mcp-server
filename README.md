# MySQL MCP Server

This repository provides the direct MySQL connection layer and local stdio MCP server. Configuration lives in `src/config.ts`, database pooling in `src/db/pool.ts`, and the MCP entry point is `src/server.ts`.

The server creates one bounded pool and exposes only two read-only metadata tools: `list_accessible_schemas` and `list_accessible_tables`. Both use `information_schema`, return at most 100 deterministically ordered metadata records, and reflect the configured account's effective access. The table tool requires a `schema` filter. It does not expose arbitrary SQL, table rows, or HTTP hosting.

## Runtime configuration

Supply all operational values through the process environment when the application starts. Do not commit environment files, connection strings, credentials, or TLS material.

Use a dedicated least-privilege database account. This layer does not grant, change, or elevate database permissions.

| Variable                   | Required | Purpose                                                         |
| -------------------------- | -------- | --------------------------------------------------------------- |
| `MYSQL_HOST`               | Yes      | Hostname or IPv4 address only; no scheme, port, or path.        |
| `MYSQL_PORT`               | No       | TCP port. Defaults to the MySQL default.                        |
| `MYSQL_DATABASE`           | Yes      | Database identifier.                                            |
| `MYSQL_USER`               | Yes      | Database username.                                              |
| `MYSQL_PASSWORD`           | Yes      | Database password.                                              |
| `MYSQL_POOL_LIMIT`         | No       | Maximum pool size; defaults to and cannot exceed 2.             |
| `MYSQL_QUEUE_LIMIT`        | No       | Maximum queued acquisition requests; must be between 1 and 100. |
| `MYSQL_CONNECT_TIMEOUT_MS` | No       | Timeout for opening a database connection.                      |
| `MYSQL_QUERY_TIMEOUT_MS`   | No       | Timeout to pass to future query calls; defaults to 30 seconds.  |
| `MYSQL_IDLE_TIMEOUT_MS`    | No       | Idle connection timeout.                                        |
| `MYSQL_TLS`                | No       | Enables TLS when set to `true`.                                 |
| `MYSQL_TLS_CA_FILE`        | No       | Externally managed CA certificate path.                         |
| `MYSQL_TLS_CERT_FILE`      | No       | Externally managed client certificate path.                     |
| `MYSQL_TLS_KEY_FILE`       | No       | Externally managed client key path.                             |

The layer reads optional TLS files only after TLS has been explicitly enabled. Peer verification cannot be disabled. Certificate paths and contents are not included in errors, and the repository ignores common environment and certificate-file patterns.

## Use

Install declared dependencies, build the source, then start the local MCP stdio server:

```bash
npm run build
npm start
```

The server validates runtime configuration and composes the MySQL connection layer at process startup. It communicates exclusively over standard input/output and does not open an HTTP listener.

To compose the layer in another local entry point:

```js
import { createConnectionLayer } from './dist/db/pool.js';

const mysql = createConnectionLayer();
```

The resulting `mysql.pool` is intended for a later, tightly controlled query layer. `mysql.queryTimeoutMs` supplies the configured timeout for that layer. Multiple SQL statements are disabled in the driver configuration.

## Validation

Run formatting checks, lint, and unit tests without any database or credentials:

```bash
npm run format:check
npm run lint
npm test
```

An integration check is opt-in and performs only a connection acquisition and release; it does not inspect schema or mutate data. Provide the required runtime environment variables externally, set `MYSQL_INTEGRATION_TEST` to `true`, then run:

```bash
npm run test:integration
```

For PowerShell, set the opt-in flag in the current session with `$env:MYSQL_INTEGRATION_TEST = 'true'` before running the command. In POSIX shells, prefix the command with `MYSQL_INTEGRATION_TEST=true`.
