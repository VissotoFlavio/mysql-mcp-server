# Agent guidance structure

Keep universal repository policy in the root `AGENTS.md`, directory-specific
constraints in scoped files, implemented security and operational facts in
`docs/`, and narrow repeatable workflows in `.agents/skills/`.

Create a root rule only when it applies broadly and is unsafe to forget. Create
a scoped rule only for local constraints. Create a skill only for a recurring
or high-risk workflow that needs more guidance than normal engineering
judgment. Its `name` and `description` must make activation precise, and its
body must link to canonical documentation rather than duplicate it.

Skills never grant authority to query or mutate a database, change a schema,
bypass opt-ins or confirmations, publish a release or change infrastructure.
Keep credentials, local settings and MCP registration outside versioned
guidance.
