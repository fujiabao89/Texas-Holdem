# Review priorities

Review correctness and safety before maintainability. Only leave comments that identify a concrete defect, a material regression risk, or a violated repository rule and explain the smallest safe correction.

## Poker domain

- `packages/poker-engine` is pure, deterministic domain logic. It must not import transport, persistence, UI, framework or ambient time/randomness concerns.
- Preserve card uniqueness, chip conservation, legal action order, minimum-raise behavior, all-in, side-pot, split-pot, showdown and state-machine invariants.
- A rule or settlement change needs focused automated tests, including adversarial and edge cases.

## Protocol and runtime

- `packages/protocol` owns runtime wire schemas and inferred types. Do not allow parallel DTO definitions to drift.
- Commands require identity/idempotency; events preserve version, table, hand and monotonic sequence semantics.
- The game server validates every client request and is the only authority that mutates game state. Reconnection and persistence changes must not duplicate actions or lose authoritative state.

## Security and operations

- Review authentication, authorization, input validation, secrets, audit trails, transaction boundaries and error handling.
- This project is simulation-chips only. Flag any feature that introduces real-money transfer, payment, withdrawal or custody behavior without explicit product, legal and security approval.
- Treat workflow and dependency changes as security-sensitive. Preserve least privilege and protected-branch checks.

## Review hygiene

- Do not comment on formatter-only style, generated files, lockfiles or speculative refactors.
- Refer to `AGENTS.md`, `CONTRIBUTING.md` and the documents listed in `files.json` when assessing an architectural or process rule.
