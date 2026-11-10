# Website and repository intelligence audit

## Scope and method

This audit follows the current request path through connection routes, source discovery, extraction, analysis/chunking, persistence, search, answer orchestration, job reporting, dashboard status, and tests. Findings below are based on the checked-in implementation and the baseline test run; they are not claims about an external production deployment.

## Existing architecture

1. `POST /projects/:id/connect/website` and `POST /projects/:id/connect/github` validate and enqueue work in `src/routes/knowledge.js`. Project creation can enqueue both sources in `src/routes/projects.js`.
2. `src/knowledge/indexer.js` schedules jobs with `setImmediate` in the API process. Website jobs call `crawlWebsite`; repository jobs call `fetchRepository`.
3. `src/understanding/analyzer.js` derives static architecture signals and splits files into line-based chunks. `src/lib/db.js` stores project-scoped profiles and chunks in a JSON file, separately replacing code and website chunks.
4. `src/assistant/retrieval.js` uses project-scoped BM25 and, when configured and available, optional embeddings with reciprocal-rank fusion and a relevance gate. Embeddings are stored in a per-project JSON file. The assistant orchestrator selects project evidence and generates evidence-constrained answers.
5. The dashboard polls jobs while they are running and displays source-level skip warnings.

## Confirmed failure causes and impact

### Website discovery and extraction

- **Static HTTP only:** `src/understanding/crawler.js` fetches HTML with `fetch`; it does not render JavaScript. The README explicitly says JavaScript-only pages are not implemented. SPA routes that return an HTML shell are marked in `skipped.jsRendered`, but the shell is still stored and chunked as page content. This can both miss content and create misleading route entries.
- **Narrow discovery:** The crawler follows same-origin anchor `href`s found in the initial response only. It does not consult `robots.txt`, sitemap files, canonical links, rendered links, or application route manifests. Routes behind client-side navigation or not linked in source HTML are missed.
- **Unbounded URL variants within the page cap:** URLs are only fragment-stripped; query variants are not normalized, canonical redirects are not recorded as page identity, and there is no duplicate-content detection. The fixed default cap is 40 pages. Unvisited URLs are reported only from the queued remainder.
- **Limited coverage evidence:** Failed requests are reduced to URL strings, losing status/error details. There is no per-page extracted/indexed state or explicit partial/blocked/auth-required classification.
- **Incomplete page intelligence:** HTML is converted to text for chunks, while `extractPages` collects a small set of title/description/headings/forms/links. It does not inspect rendered controls, page states, pagination behavior, or lazy-loaded content.

### Repository discovery and extraction

- **Intentional caps can silently omit content:** `src/understanding/github.js` selects at most `GITHUB_MAX_FILES` (default 400), skips files larger than 600,000 bytes, and reports those two groups plus GitHub's truncated-tree flag. The indexability allowlist excludes unrecognized extensions, generated/vendor paths, and lockfiles; excluded-by-policy files are not included in coverage totals.
- **Fetch failures disappear:** A failed `raw.githubusercontent.com` response is converted to `null` and removed from `files`; it is not added to a failed-file report. There is no retry or per-file extraction result. The progress count reports fetched files, but not failed ones.
- **File processing can truncate silently:** `chunkProject` slices each 30/40/60-line piece to 6,000 characters, with no truncation marker. Large files over the GitHub threshold are skipped whole rather than read in ranges.
- **Useful provenance exists but is incomplete:** The repository commit SHA is kept in profile metadata; chunks carry project, origin, source path, and line bounds, but not commit/version metadata. Re-indexing replaces chunks for that origin, so deleted files disappear after a successful snapshot, but failed/partial snapshots can replace good content.

### Index status and consistency

- **Success is overstated:** `indexFiles` sets the project to `indexed` immediately, while source `skipped` fields may contain failures or limits. The job wrapper then marks any non-throwing run `completed`, even when the source report has missing files/pages. There is no `completed_with_warnings` state.
- **Publishing is not transactional:** Profile/chunks are replaced before background embedding work completes. Embedding failures are caught only by a `console.warn`; they do not affect job status. A partially fetched repository can replace the current code index, and there is no last-known-good snapshot boundary.
- **Job execution is process-local:** Jobs use `setImmediate` and an in-memory running set. They do not survive an API process restart and have no durable queue/retry policy. Progress is source-fetch progress rather than stage-by-stage indexing progress.
- **Freshness is partial:** A GitHub push webhook exists, but website recrawl scheduling, HTTP validators, changed-page/file processing, rename accounting, and index-version publication are not implemented.

### Retrieval and answers

- **Strengths verified:** Search is not semantic-only. `src/assistant/retrieval.js` implements BM25 plus optional embeddings, exact path-token weighting, metadata type filtering, project-specific corpus construction, de-duplication, and a relevance gate. Chunk queries are scoped to one project.
- **Remaining retrieval risks:** Embeddings are optional/background and semantic errors fall back to keyword-only search. The simpler `/knowledge/search` endpoint is BM25-only. Neither path can retrieve content that was not discovered, fetched, or retained during chunking. The corpus cache version uses chunk count and first/last IDs, so it relies on replacement changing those sentinel IDs.
- **Answer evidence is only as complete as ingestion:** Project/source identifiers and line ranges support citations for code chunks; web pages have paths but no reliable canonical/final URL metadata on chunks. There is no auditable cross-source feature inventory or explicit page-to-component/API/model relationship graph.

### Dashboard and tests

- The dashboard polls jobs every 1.5 seconds and shows several existing skip warnings, but each source is labeled `indexed` whenever a profile part exists, even if its coverage report contains gaps. It does not show discovered/extracted/failed totals or retry individual failures.
- Existing tests cover project isolation and knowledge lookup but do not exercise sitemap/robots discovery, SPA fallback duplication, rendered content, pagination, GitHub raw-file failures, per-file coverage accounting, or honest warning statuses.
- Baseline `npm test` from the project root completed with **175 passing and 1 failing**. The pre-existing failure is `tests/agent.test.js:288`: the draft-validation test expected an unsupported “9 businesses” claim to be rejected, but got “There are 9 businesses registered.” This is outside the ingestion changes and is recorded rather than attributed to this task.

## Prioritized implementation targets

1. Make source snapshots report discovered, fetched, indexed, skipped, duplicate, and failed items with reasons, and do not call partial runs fully complete.
2. Improve website discovery with robots/sitemap parsing, canonical URL handling, duplicate/fallback detection, and clear bounds. Provide a browser-rendering adapter only when a supported runtime is available; never claim an unrendered SPA was read.
3. Make GitHub file retrieval failures and policy exclusions visible; preserve snapshot SHA and avoid silently truncating chunks.
4. Add deterministic tests for those behaviors and update dashboard/documentation to match the actual guarantees.
5. Keep existing project isolation and hybrid retrieval behavior; extend provenance and feature relationships only where evidence can be derived safely.

## Explicitly not established by this audit

- No live website or GitHub token was provided, so real-world route/file coverage and provider rate-limit behavior were not measured.
- The baseline run does not establish retrieval accuracy against the requested 200-question target; the repository contains no such labeled benchmark.
- At the audit baseline, a browser automation dependency/runtime was not configured. This implementation adds Playwright and configures Chromium in the API container; local deployments still need the documented browser installation.

## Implementation and verification follow-up (2026-11-09)

The ingestion and reporting changes now address several baseline findings:

- Website discovery consults robots rules and sitemap indexes, normalizes canonical/tracking URL variants, detects duplicate content, and uses bounded Playwright rendering and scrolling for JavaScript pages. It records per-page status, extracted page metadata, forms and controls; it never submits forms.
- GitHub indexing pins a commit, records failed/oversized/over-limit files and truncated trees, and splits oversized source lines instead of silently truncating chunks. Credentials are redacted before project content is analyzed or indexed.
- Website URLs and source-version metadata are retained through chunks, search results, and assistant evidence. Source coverage gaps produce `completed_with_warnings` status and are surfaced in the dashboard.
- A partial GitHub refresh or website crawl no longer replaces an existing good source index; the last indexed snapshot remains queryable and the attempted refresh is reported as a warning. A first, incomplete index can still index its readable subset with an explicit warning.
- Regression coverage now exercises local SPA rendering, sitemap/robots behavior, coverage reporting, oversized-file and failed-file accounting, redirect validation, and last-known-good retention.

Verification after these changes: `node --test tests/website.test.js` passed all 6 tests, and `npm run build` passed. The full `npm test` run completed with 181 passing tests and one pre-existing failure at `tests/agent.test.js:288`: its draft-validation assertion accepts the unsupported response “There are 9 businesses registered.” No new failures were reported.

### Remaining requirements and limits

- The implementation does not yet build a verified website-page-to-component/API/model relationship graph; no relationship is inferred from filenames alone.
- Scheduled or incremental website synchronization, durable background queues, and versioned atomic publication are still absent.
- Interactive page-state and pagination exploration are not implemented. Forms are inspected only and intentionally never submitted.
- No labeled 200-question benchmark is present, and no live production website, repository, or real credential was available for validation. The local browser fixture does not establish coverage on arbitrary production sites.
