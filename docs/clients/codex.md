# Codex client setup

[Back to README](../../README.md) · [Getting started](../getting-started.md)

Codex can launch the server as a local stdio child process. Add the following entry to the Codex MCP configuration file, preserving the absolute paths for your machine:

- POSIX: `~/.codex/config.toml`
- Windows PowerShell: `$env:USERPROFILE\.codex\config.toml`

```toml
[mcp_servers.mysql-local]
command = "node"
args = [
  "--env-file=/absolute/path/to/mysql-mcp-server/.env",
  "/absolute/path/to/mysql-mcp-server/node_modules/mysql-mcp-server/dist/server.js",
]
```

On Windows, use Windows paths in the string values, for example:

```toml
[mcp_servers.mysql-local]
command = "node"
args = [
  "--env-file=C:\\path\\to\\mysql-mcp-server\\.env",
  "C:\\path\\to\\mysql-mcp-server\\node_modules\\mysql-mcp-server\\dist\\server.js",
]
```

Do not put `MYSQL_PASSWORD`, a connection string, TLS key material, or other secrets in `config.toml`. If the client or supervisor supports environment injection, pass the four required `MYSQL_*` values there and remove the `--env-file` argument.

After saving the entry, fully restart or reload Codex. In a new conversation, confirm that `mysql-local` exposes the five read-only tools before asking for DML or DDL. If the tools do not appear, check the paths and the stderr diagnostics described in [Troubleshooting](../troubleshooting.md); stdout must remain reserved for MCP messages.
