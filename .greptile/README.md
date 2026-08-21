# Greptile review configuration

Greptile uses this directory-scoped configuration rather than the legacy root `greptile.json`. The files cascade to future child `.greptile/` directories, allowing each package to add stricter local rules without duplicating repository-wide policy.

- `config.json` contains machine-readable behavior and scoped high-risk rules.
- `rules.md` explains the project review priorities in plain language.
- `files.json` names the repository documents that provide review context.

Update these files together with `AGENTS.md`, `CONTRIBUTING.md`, or architecture specifications when their review-relevant requirements change.
