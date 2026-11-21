# MySQL MCP test guidance

- Keep unit tests deterministic and free of real databases, data, credentials
  or connection values.
- Integration tests are opt-in and must use an explicitly authorized isolated
  disposable database.
- Add focused coverage for opt-in, confirmation, audit, redaction and
  indeterminate-outcome behavior when those boundaries change.
