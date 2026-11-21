# MySQL MCP workflow guidance

- Preserve the distinction between CI validation, internal package candidates
  and any future distribution decision.
- Do not add database credentials, production database access or DML/DDL
  execution to workflows.
- Candidate generation must preserve its exact branch, check and immutable
  commit requirements. Keep workflow permissions minimal.
