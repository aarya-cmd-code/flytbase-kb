# FlytBase GTM Hackathon — Solutions Engineer Track

Implements **Problem #2 (Knowledge Base over Customer Data)** and **Problem #3
(Product Feedback Lifecycle Tracker)** on a shared data layer, per the
[4-day build plan](.) this repo was scaffolded from.

Live problem statements (fetched Aug 22, 2026):
- https://flytbase-gtm-hackathon.lovable.app/solutions-engineer/knowledge-base-over-customer-data
- https://flytbase-gtm-hackathon.lovable.app/solutions-engineer/product-feedback-lifecycle-tracker

## Stack

- **Backend**: Node.js + Express (`server/`)
- **Database**: Supabase Postgres + `pgvector` (schema in `supabase/schema.sql`)
- **LLM**: Anthropic Claude (`claude-sonnet-4-6`) for triage, retrieval synthesis, contradiction-flagging, and status summaries
- **Embeddings**: OpenAI `text-embedding-3-small` for the customer-data vector index
- **Live docs**: `docs.flytbase.com` / `releases.flytbase.com` are fetched **fresh on every question** (sitemap + keyword heuristic by default, or a real search API if you set `SEARCH_API_URL`/`SEARCH_API_KEY`) — nothing from those sites is ever written to the database, satisfying the "not a static copy" requirement.
- **Frontend**: a single static dashboard (`public/index.html`, vanilla JS) with two tabs matching the two live-demo scripts exactly.
- **Deploy**: Render (`render.yaml`) for the app, Supabase for the DB.

## Repo layout

```
server/
  index.js         Express app + route mounting
  db.js             Supabase client
  embeddings.js     OpenAI embeddings + content hashing
  llm.js            Claude wrapper: triage, synthesis, contradiction/summary prompts
  docs_fetch.js      Live docs.flytbase.com / releases.flytbase.com retrieval
  parse.js          Markdown table/section parsers for the 5 dataset files
  ingest.js         Parses data/*.md -> upserts core tables -> incrementally re-embeds only changed rows
  retrieve.js       pgvector similarity search over the customer corpus
  routes/
    ask.js           Problem #2 — POST /api/ask, GET /api/ask/usage
    triage.js        Problem #3 — POST /api/triage
    pipeline.js      Problem #3 — stage progression, feedback loop-back, team views, watchers, summaries
data/               The 5 provided dataset files (accounts, issues, feature_requests, tasks, meeting_notes)
supabase/schema.sql  Full DB schema incl. pgvector index + match_doc_chunks() RPC
public/index.html    Demo dashboard (two tabs)
render.yaml          Render web service definition
```

## Data model note

`accounts.md` / `feature_requests.md` were provided twice in the upload with
identical content — this repo only reads each file once via `data/`.

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. In the SQL editor, run `supabase/schema.sql` (enables `pgvector`, creates all tables + the `match_doc_chunks` RPC).
3. Copy your Project URL and **service_role** key (Settings → API) — server-side only, never ship this to a browser.

### 2. Environment

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY
```

### 3. Install & ingest

```bash
npm install
npm run ingest     # parses data/*.md, upserts core tables, embeds the corpus into doc_chunks
npm start           # http://localhost:3000
```

Open `http://localhost:3000` — the dashboard covers both demo scripts.

### 4. Re-running ingest after a dataset update

The hackathon may issue a follow-up corpus update mid-judging to test that the
system "reflects an updated corpus without a full manual rebuild." To handle
that:

```bash
# swap in the new files under data/, then either:
npm run ingest
# or, without touching the server:
curl -X POST https://<your-deploy-url>/api/ingest
```

`ingest.js` hashes each record's chunk text (`content_hash`) and only calls
the embeddings API for rows that are new or changed — everything else is
skipped, so this stays fast regardless of corpus size.

## Deploying

**Render**
1. Push this repo to GitHub.
2. In Render: New → Blueprint → point at the repo (`render.yaml` is auto-detected), or New → Web Service with build `npm install` / start `npm start`.
3. Set the env vars from `.env.example` in the Render dashboard (they're marked `sync: false` in `render.yaml` so Render will prompt for them).
4. After first deploy, run ingestion once: `curl -X POST https://<your-app>.onrender.com/api/ingest`.

**Supabase**
Already covered above — Supabase hosts only the Postgres DB here; the Express app runs on Render (or anywhere else Node runs — Railway, Fly.io, a VM, etc. work identically since nothing here is Render-specific beyond `render.yaml`).

## API reference

### Problem #2 — Knowledge Base
- `POST /api/ask` `{ question: string }` → `{ answer, sources: { customer[], docs[] }, contradictionFlag }`
  - Retrieves from the customer-data vector index (Supabase/pgvector) and live docs (fetched fresh), and asks Claude to answer **only** from that context, citing `[source_id]` inline, and to say plainly when it lacks enough information.
- `GET /api/ask/usage` → most-asked questions (bonus: usage signal)

### Problem #3 — Feedback Lifecycle
- `POST /api/triage` `{ raw_text, account_name? }` → classifies into `feature_request | bug | support`, routes to `product | engineering | cs`, creates a tracked request at stage `new`.
- `GET /api/requests` — list (filter by `?team=` or `?stage=`)
- `GET /api/requests/:id` — single per-item view with full event history (Must Have: not fragmented per team)
- `GET /api/requests/:id/team-view?team=product|dev` — bonus team-scoped view
- `POST /api/requests/:id/advance` `{ to_stage }` — `new → in_product_review → in_development → shipped`
- `POST /api/requests/:id/sub-stage` `{ sub_stage, bug_attached? }` — bonus: `in_development|in_testing|in_staging|in_production`
- `POST /api/requests/:id/mark` `{ demo_given?, customer_tried? }` — bonus tracking
- `POST /api/requests/:id/feedback` `{ feedback_text }` — only once `stage === 'shipped'`; logs an event visible to **both** `product` and `engineering`, and asks Claude whether the feedback is really a disguised new request — if so, auto-creates a new linked request (bonus: prevents an untracked thread)
- `POST /api/requests/:id/watch` `{ watcher_name }` — bonus ping-for-visibility
- `GET /api/requests/:id/summary` — bonus: Claude-drafted customer-pasteable status update

## What's implemented vs. deferred

**Problem #2 — done**: customer-corpus grounding, live (non-cached-content) docs retrieval, combined-source reasoning, inline citations, "not enough information" fallback, incremental re-embed on corpus update, usage-log bonus, contradiction-flag bonus.
**Problem #2 — partial**: multi-part question decomposition is left to Claude's own reasoning inside `synthesizeAnswer` rather than an explicit decomposition step; `docs_fetch.js`'s no-API-key fallback uses a sitemap + keyword heuristic, not true search — set `SEARCH_API_URL`/`SEARCH_API_KEY` (e.g. Serper.dev) for materially better doc relevance.

**Problem #3 — done**: triage + routing, single per-item view, 4-stage progression, shipped→feedback→product+dev loop-back, new-request-in-disguise detection, sub-stages, demo/tried flags, team views, watchers, auto-summary.

## Security note

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security and must only ever be
used server-side, exactly as it's used here (never sent to `public/index.html`).
