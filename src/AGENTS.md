# MySQL MCP source guidance

- Preserve the read-only default and the narrow, structured MCP tool surface.
- Do not add arbitrary SQL, multi-statement execution, dynamic connection
  inputs, unbounded export or weaker validation.
- Keep result limits, sanitized errors, prepared values, identifier validation
  and audit behavior intact.
- Read the applicable tool contract before changing query, DML or DDL behavior.
