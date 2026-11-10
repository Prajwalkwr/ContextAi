# Security

## Tenant isolation

- Every project route runs `authenticate` then `requireProject(scope)`. The project id in the URL must belong to the caller: owner for developer tokens, the key's own project for API keys.
- Storage accessors take a project id; knowledge search, schema discovery and queries never cross projects.
- Covered by tests: cross-project public key → 403, another developer → 403, knowledge search isolation, prompt injection in indexed files cannot widen access.

## Credentials

- Database connection strings and tool headers are encrypted with AES-256-GCM (`ENCRYPTION_KEY`) and never returned by the API (tested by grepping the data file).
- Secret keys are stored as SHA-256 hashes and shown once. Public keys are limited to `ask` and `search`.
- Passwords use bcrypt. Access tokens live 2 hours; refresh tokens 7 days.
- The API refuses to start without `JWT_SECRET` and `ENCRYPTION_KEY`.
- `GEMINI_API_KEY` and `OPENAI_API_KEY` are read only by the API server. They are never sent to the dashboard, widget or SDK, are never logged, and are redacted from Gemini error messages before those are recorded.

## Data access

- Read-only by construction: the query spec has no write operations, and PostgreSQL / MySQL queries run inside read-only transactions with a statement timeout. Use a read-only database user as well.
- Allowlisted collections only; every field is checked against the discovered schema; values must be primitives, so operator injection is impossible.
- Results are capped at 1000 rows per query.
- Registered tools have fixed URLs; only declared parameters may vary. GET tools run directly; POST/PUT/PATCH/DELETE tools never run from an investigation or a direct call — only after a signed-in owner approves a request, exactly once, with an `Idempotency-Key`. Public keys cannot request actions. Every request, approval, rejection and execution is audited.
- GraphQL sources must be read-only queries; mutations are rejected at registration.
- Outbound HTTP (sources, tools, crawler) is blocked for loopback, private and link-local addresses unless `ALLOW_PRIVATE_NETWORK=true`.

## Prompt injection

- Questions, repository files and database content never choose which queries run; the planner is deterministic.
- When an LLM is enabled it only rephrases verified findings. Retrieved content is passed inside `<untrusted_project_content>` with instructions to ignore any directives in it.
- Google Search never receives the project's private records or credentials. A pure web question sends Gemini only the question and the conversation. A mixed question also sends the project facts ContextAI already verified (as `<untrusted_project_context>`). Search Suggestions HTML from Google is rendered in a sandboxed iframe without script permission. Links in a grounded answer that Google did not return are removed.

## Other controls

- Rate limiting per credential (default 120 requests/minute).
- zod validation on every request body.
- Audit log for data queries, tool calls, indexing, integration and key changes.
- GitHub webhooks verified with HMAC-SHA256 and a timing-safe comparison.

## Not yet covered

- Team members and per-end-user role rules (today: one owner per project, plus key scopes).
- Short-lived per-end-user tokens minted by the host app's backend.
- Key rotation for `ENCRYPTION_KEY`.
