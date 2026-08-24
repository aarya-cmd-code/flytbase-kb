-- FlytBase GTM Hackathon — Problem #2 (Knowledge Base) + Problem #3 (Feedback Lifecycle)
-- Run this once in the Supabase SQL editor (or via `supabase db push`).

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ============================================================
-- CUSTOMER-DATA CORPUS (source of truth, re-ingested from data/*.md)
-- ============================================================

create table if not exists accounts (
  id text primary key,
  name text not null,
  industry text,
  region text,
  tier text,
  health text,
  arr numeric default 0,
  owner text,
  devices text[] default '{}'
);

create table if not exists issues (
  id text primary key,
  account_name text,
  category text,       -- Bug | Support | Question | Implementation
  status text,
  title text
);

create table if not exists feature_requests (
  id text primary key,   -- slug of title, since source has no explicit id
  title text,
  product_area text,
  status text,           -- new | in_progress | completed | declined
  accounts text[] default '{}',
  mentions int default 0,
  revenue_impact numeric default 0
);

create table if not exists tasks (
  id text primary key,
  account_name text,
  title text,
  assignee text,
  priority text,
  status text,
  due date
);

create table if not exists meeting_notes (
  id text primary key,
  account_name text,
  topic text,
  attendees text[] default '{}',
  meeting_date date,
  action_items text[] default '{}'
);

-- ============================================================
-- RETRIEVAL INDEX (Problem #2) — one embeddable chunk per record.
-- content_hash enables incremental re-embedding: only rows whose
-- hash changed since the last ingest run get re-embedded.
-- ============================================================

create table if not exists doc_chunks (
  id text primary key,             -- e.g. 'issue:ISS-0001'
  source_table text not null,      -- issues | feature_requests | tasks | meeting_notes | accounts
  source_id text not null,
  account_name text,
  content text not null,
  content_hash text not null,
  embedding vector(1536),
  updated_at timestamptz default now()
);

create index if not exists doc_chunks_embedding_idx
  on doc_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index if not exists doc_chunks_account_idx on doc_chunks (account_name);

-- Vector similarity search RPC used by the /api/ask route
create or replace function match_doc_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  filter_account text default null
)
returns table (
  id text,
  source_table text,
  source_id text,
  account_name text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    d.id, d.source_table, d.source_id, d.account_name, d.content,
    1 - (d.embedding <=> query_embedding) as similarity
  from doc_chunks d
  where filter_account is null or d.account_name = filter_account
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

-- Usage log (bonus: "which questions get asked most often")
create table if not exists query_log (
  id bigserial primary key,
  question text not null,
  used_customer_data boolean default false,
  used_docs boolean default false,
  sources jsonb,
  contradiction_flag boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- PRODUCT FEEDBACK LIFECYCLE TRACKER (Problem #3)
-- ============================================================

create table if not exists requests (
  id text primary key default ('REQ-' || substr(gen_random_uuid()::text, 1, 8)),
  raw_text text not null,
  title text,
  type text not null,              -- feature_request | bug | support
  team text not null,              -- product | engineering | cs
  account_name text,
  stage text not null default 'new', -- new -> in_product_review -> in_development -> shipped
  sub_stage text,                  -- optional bonus: in_development|in_testing|in_staging|in_production
  linked_request_id text references requests(id), -- bonus: feedback recognized as a new request
  demo_given boolean default false,
  customer_tried boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists request_events (
  id bigserial primary key,
  request_id text references requests(id) on delete cascade,
  event_type text not null,        -- stage_change | feedback | note | demo | customer_tried
  from_stage text,
  to_stage text,
  detail text,
  visible_to text[] default '{}',  -- e.g. ['product','dev']
  created_at timestamptz default now()
);

create table if not exists watchers (
  id bigserial primary key,
  request_id text references requests(id) on delete cascade,
  watcher_name text not null,
  notified_at timestamptz
);

create index if not exists requests_stage_idx on requests (stage);
create index if not exists request_events_request_idx on request_events (request_id);
