# Configuration reference

[Back to README](../README.md)

The canonical copyable template is [`.env.example`](../.env.example). Configuration is read from the launching process and validated strictly at startup.

## Empty versus absent

Node's `--env-file` turns `KEY=` into a present empty string. This server distinguishes that from an absent variable:

- Required values (`MYSQL_HOST`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`) must be filled.
- Optional values must be omitted or set to a valid value. A present empty optional value is rejected.
- Boolean values must be exactly `true` or `false`; strict opt-in and confirmation variables do not accept whitespace or alternate casing.
- `MYSQL_DDL_DROP_SCHEMA_ALLOWLIST` must be omitted when unused; if present, it must be a non-empty exact comma-separated list that excludes `MYSQL_DATABASE` and protected system schemas.

## Capability defaults

| Capability                                                    | Enablement                                                                                                                         | Default  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Read-only discovery, description, bounded SELECT, and EXPLAIN | No extra flag                                                                                                                      | Enabled  |
| `insert_rows`, `update_rows`, `delete_rows`                   | `MYSQL_DML_ENABLED=true`                                                                                                           | Disabled |
| Non-destructive structured DDL                                | `MYSQL_DDL_ENABLED=true`                                                                                                           | Disabled |
| `create_schema`                                               | DDL plus `MYSQL_DDL_CREATE_SCHEMA_ENABLED=true`                                                                                    | Disabled |
| Destructive or dependency-sensitive DDL                       | DDL plus the operation-specific enablement, metadata attestation, allowlist, or confirmation described in the README tool contract | Disabled |

The flags only control which bounded tools are registered. They do not grant MySQL permissions. Use a dedicated account with the smallest effective grants for the target objects and keep write capabilities disabled for first use.

## Connection and TLS settings

`MYSQL_PORT` defaults to 3306. Pool, queue, connect timeout, query timeout, and idle timeout settings have conservative bounded defaults documented in the README table. `MYSQL_TLS=true` enables TLS; peer verification cannot be disabled, and certificate paths are accepted only when TLS is enabled. TLS material is read from external files and is never returned in errors.

Integration-only variables are present only as commented examples in the published template. Set them only for the explicitly authorized isolated test flow in [development and validation guidance](../README.md#validation); never use them against shared or production data.
