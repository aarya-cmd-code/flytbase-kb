import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from './db.js';
import { embedBatch, hashContent } from './embeddings.js';
import {
  parseAccounts,
  parseIssues,
  parseFeatureRequests,
  parseTasks,
  parseMeetingNotes
} from './parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Build the text a chunk will be embedded from, and a stable chunk id.
function chunksFromIssues(rows) {
  return rows.map((r) => ({
    id: `issue:${r.id}`,
    source_table: 'issues',
    source_id: r.id,
    account_name: r.account_name,
    content: `[${r.category} issue, status ${r.status}] Account: ${r.account_name}. ${r.title}`
  }));
}
function chunksFromFeatureRequests(rows) {
  return rows.map((r) => ({
    id: `feature_request:${r.id}`,
    source_table: 'feature_requests',
    source_id: r.id,
    account_name: null,
    content: `[Feature request, area ${r.product_area}, status ${r.status}] "${r.title}" — requested by ${r.accounts.join(', ')} (${r.mentions} mentions, est. revenue impact $${r.revenue_impact}).`
  }));
}
function chunksFromTasks(rows) {
  return rows.map((r) => ({
    id: `task:${r.id}`,
    source_table: 'tasks',
    source_id: r.id,
    account_name: r.account_name,
    content: `[Task, priority ${r.priority}, status ${r.status}, due ${r.due}] Account: ${r.account_name}. ${r.title}. Assignee: ${r.assignee}.`
  }));
}
function chunksFromMeetings(rows) {
  return rows.map((r) => ({
    id: `meeting:${r.id}`,
    source_table: 'meeting_notes',
    source_id: r.id,
    account_name: r.account_name,
    content: `[Meeting ${r.meeting_date}] Account: ${r.account_name}. Topic: ${r.topic}. Attendees: ${r.attendees.join(', ')}. Action items: ${r.action_items.join('; ') || 'none'}.`
  }));
}
function chunksFromAccounts(rows) {
  return rows.map((r) => ({
    id: `account:${r.id}`,
    source_table: 'accounts',
    source_id: r.id,
    account_name: r.name,
    content: `[Account] ${r.name} — ${r.industry} industry, ${r.region}, ${r.tier} tier, health ${r.health}, ARR $${r.arr}, owner ${r.owner}. Devices: ${r.devices.join(', ')}.`
  }));
}

async function upsertCore(table, rows, conflictKey = 'id') {
  if (!rows.length) return;
  const { error } = await supabase.from(table).upsert(rows, { onConflict: conflictKey });
  if (error) throw new Error(`upsert ${table} failed: ${error.message}`);
  console.log(`[ingest] upserted ${rows.length} rows into ${table}`);
}

/**
 * Incremental embedding: compare each chunk's content_hash against what's
 * already stored. Only chunks that are new or whose text changed get sent to
 * the embeddings API and re-written. Unchanged chunks are skipped entirely —
 * this is what lets a follow-up dataset update "reflect without a full
 * rebuild" per the Problem #2 spec.
 */
async function upsertChunksIncremental(chunks) {
  if (!chunks.length) return { embedded: 0, skipped: 0 };

  const ids = chunks.map((c) => c.id);
  const { data: existing, error } = await supabase
    .from('doc_chunks')
    .select('id, content_hash')
    .in('id', ids);
  if (error) throw new Error(`fetch existing chunks failed: ${error.message}`);

  const existingHash = new Map((existing || []).map((r) => [r.id, r.content_hash]));

  const toEmbed = chunks.filter((c) => existingHash.get(c.id) !== hashContent(c.content));
  if (toEmbed.length === 0) {
    console.log(`[ingest] ${chunks.length} chunks checked, 0 changed — nothing to re-embed`);
    return { embedded: 0, skipped: chunks.length };
  }

  // batch in groups of 100 to stay well under API payload limits
  const BATCH = 100;
  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const batch = toEmbed.slice(i, i + BATCH);
    const vectors = await embedBatch(batch.map((c) => c.content));
    const rows = batch.map((c, idx) => ({
      id: c.id,
      source_table: c.source_table,
      source_id: c.source_id,
      account_name: c.account_name,
      content: c.content,
      content_hash: hashContent(c.content),
      embedding: vectors[idx],
      updated_at: new Date().toISOString()
    }));
    const { error: upErr } = await supabase.from('doc_chunks').upsert(rows, { onConflict: 'id' });
    if (upErr) throw new Error(`upsert doc_chunks failed: ${upErr.message}`);
    embedded += batch.length;
    console.log(`[ingest] embedded ${embedded}/${toEmbed.length} changed chunks`);
  }
  return { embedded: toEmbed.length, skipped: chunks.length - toEmbed.length };
}

export async function runIngest() {
  console.log(`[ingest] reading dataset from ${DATA_DIR}`);

  const accounts = parseAccounts(path.join(DATA_DIR, 'accounts.md'));
  const issues = parseIssues(path.join(DATA_DIR, 'issues.md'));
  const featureRequests = parseFeatureRequests(path.join(DATA_DIR, 'feature_requests.md'));
  const tasks = parseTasks(path.join(DATA_DIR, 'tasks.md'));
  const meetings = parseMeetingNotes(path.join(DATA_DIR, 'meeting_notes.md'));

  await upsertCore('accounts', accounts);
  await upsertCore('issues', issues);
  await upsertCore('feature_requests', featureRequests);
  await upsertCore('tasks', tasks);
  await upsertCore('meeting_notes', meetings);

  const allChunks = [
    ...chunksFromAccounts(accounts),
    ...chunksFromIssues(issues),
    ...chunksFromFeatureRequests(featureRequests),
    ...chunksFromTasks(tasks),
    ...chunksFromMeetings(meetings)
  ];

  const result = await upsertChunksIncremental(allChunks);
  console.log(`[ingest] done. ${result.embedded} chunks (re-)embedded, ${result.skipped} unchanged & skipped.`);
  return { records: allChunks.length, ...result };
}

// allow `npm run ingest` to run this directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runIngest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[ingest] failed:', err);
      process.exit(1);
    });
}
