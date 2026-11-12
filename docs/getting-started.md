# Getting started

[Back to README](../README.md)

This guide installs the stable GitHub Release package, configures a local stdio MCP process, and reaches the first read-only tool. It does not require cloning or building the repository.

## Prerequisites

- Node.js 22 or later and npm.
- A reachable MySQL instance and a dedicated least-privilege account.
- An MCP client that can launch a local child process over stdio.
- An isolated, masked, synthetic, or otherwise non-sensitive database for evaluation.

The repository CI validates Node.js 22 and 24. This project does not currently publish a verified MySQL-version compatibility matrix; check your server version in the target environment and report compatibility issues rather than assuming support.

## 1. Download and install

Download a stable `.tgz` asset from [Releases](https://github.com/VissotoFlavio/mysql-mcp-server/releases). Do not use a prerelease unless you are intentionally validating a candidate.

POSIX shell:

```bash
mkdir -p "/absolute/path/to/mysql-mcp-server" "/absolute/path/to/downloads"
npm install --omit=dev --prefix "/absolute/path/to/mysql-mcp-server" "/absolute/path/to/downloads/mysql-mcp-server-<version>.tgz"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force 'C:\path\to\mysql-mcp-server' | Out-Null
npm install --omit=dev --prefix 'C:\path\to\mysql-mcp-server' 'C:\path\to\downloads\mysql-mcp-server-<version>.tgz'
```

The package includes `dist/server.js` and the official `.env.example`. The package is not published to npm; do not replace the release asset with `npx mysql-mcp-server`.

## 2. Configure the minimum safe environment

Copy the packaged template to an untracked `.env` file and fill only the four required values first:

POSIX shell:

```bash
cp "/absolute/path/to/mysql-mcp-server/node_modules/mysql-mcp-server/.env.example" "/absolute/path/to/mysql-mcp-server/.env"
```

Windows PowerShell:

```powershell
Copy-Item 'C:\path\to\mysql-mcp-server\node_modules\mysql-mcp-server\.env.example' 'C:\path\to\mysql-mcp-server\.env'
```

Set `MYSQL_HOST`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` in that local file. Optional settings are commented out because a present-but-empty value is invalid; an absent optional variable selects the documented default. Keep DML, DDL, integration, and destructive flags disabled unless a separate controlled workflow authorizes them.

Never commit `.env`, place credentials in client JSON, or print the file. Prefer a secret/environment injection mechanism from the process supervisor when one is available.

## 3. Register the local MCP process

The process is stdio-only. Use `node` with `--env-file` so the environment is loaded before the server starts:

```text
command: node
args:
  --env-file="/absolute/path/to/mysql-mcp-server/.env"
  "/absolute/path/to/mysql-mcp-server/node_modules/mysql-mcp-server/dist/server.js"
```

The equivalent Codex entry is documented in [clients/codex.md](clients/codex.md). A generic JSON example is shown in the README for clients that use that shape; treat it as illustrative because clients use different configuration paths and key names.

Restart or reload the MCP client after adding or changing the server entry. Do not run the command expecting a web page or a startup banner: stdout carries MCP protocol messages and operational logs belong on stderr.

## 4. Run the first read-only session

With the default `MYSQL_DML_ENABLED=false` and `MYSQL_DDL_ENABLED=false`, use these prompts in order:

1. “List the MySQL schemas and tables available to this account.”
2. “Choose one accessible table from that result and describe its columns and keys. Do not assume a schema or table name.”
3. “Based on the discovered metadata, propose a policy-approved SELECT using columns that actually exist, with a literal `LIMIT 5` and bound parameters.”
4. “Execute the approved bounded read-only query; if no accessible table or suitable columns were found, stop at metadata discovery.”
5. “Explain the execution plan for that same bounded SELECT; do not execute DML.”

The expected read-only tools are `list_accessible_schemas`, `list_accessible_tables`, `describe_table`, `execute_read_only_query`, and `explain_read_only_query`. A successful first use means the client displays the tools, discovery returns only objects visible to the account, and the description/query returns data from the isolated target. Server process startup alone does not prove that MySQL connectivity or a query succeeded.

Every read-only query must contain a literal `LIMIT` from 0 through 100 and use bound `parameters`; `LIMIT 5` is the illustrative first-query value above. Do not assume a primary key, timestamp, or “latest” ordering column. If the discovered table has no suitable deterministic ordering columns, use a metadata-only session or ask the operator to choose an appropriate bounded query. A name such as `demo_catalog.sample_records` is only an optional example for a demonstration database created beforehand, not a prerequisite. Do not ask the server to execute arbitrary SQL, remove the limit, export unrestricted data, or bypass the MySQL account's privileges.

Maintainers can validate the recommended path from the generated release artifact without a database or credentials with `npm run test:package-smoke`. The opt-in smoke test packs the project, installs the `.tgz` in a temporary directory, copies the template from the installed package, starts the installed `dist/server.js` over stdio, and verifies the handshake plus the five default read-only tools.

## If the first prompt fails

Use [Troubleshooting](troubleshooting.md). The safe first checks are the Node version, absolute paths, presence of the four required environment values, client reload, MySQL reachability, and effective grants. Do not solve an access error by using root, enabling write flags, disabling TLS verification, or retrying an uncertain mutation.
