# MySQL MCP Server project rules

## Agent guidance hierarchy

- Keep universal repository policy in this root `AGENTS.md`; use scoped files
  only for directory-specific guidance.
- Keep implemented security and operating behavior in `docs/`, and narrow
  reusable workflows in `.agents/skills/`.
- Read `docs/agent-guidance.md` before adding or changing rules or skills.
- Do not put database connection settings, credentials, MCP configuration or
  hooks in versioned agent guidance.

## GitHub, branches and CI

- Use only `gh` for GitHub operations and run `gh auth status` before them.
- Every delivery requires a GitHub issue, except releases. Never commit
  directly to `develop` or `master`.
- Feature branches use `feature/<issue-id>-<slug>` from and to `develop`.
  Releases use `release/<version>` from `develop` to `master`; hotfixes use
  `hotfix/<issue-id>-<slug>` from `master` to `master`.
- Confirm the base branch explicitly before creating a non-release branch.
  Pull requests require `Closes #<issue-number>` except releases.
- Before opening a PR, inspect the final diff, run relevant validation and
  update `CHANGELOG.md` when a change is release-facing.
- CI validates pull requests and may generate approved package candidates; it
  never connects to a production database, mutates schema or data, or publishes
  an npm package. Keep permissions minimal and secrets out of source control,
  logs and pull requests.
- Merge, release publication, database mutation and infrastructure changes
  require explicit user authorization.

## Database safety boundaries

- Preserve the read-only default. DML and DDL are controlled, opt-in tool
  paths; do not expose arbitrary SQL or dynamic connection behavior.
- Preserve exact target validation, bounded input/output, explicit confirmation
  where required, sanitized audit and no-automatic-retry behavior for unknown
  outcomes.
- Never request, log or document real credentials, connection strings,
  database contents, or production schema names.
