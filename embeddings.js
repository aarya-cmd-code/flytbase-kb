import crypto from 'node:crypto';
import 'dotenv/config';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

export function hashContent(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Embed a batch of strings. OpenAI's embeddings endpoint accepts an array
 * directly, which keeps ingestion fast (one call per ~100 chunks) and keeps
 * re-embedding cheap: ingest.js only ever passes rows whose content_hash
 * changed since the last run.
 */
export async function embedBatch(texts) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — required to build the retrieval index.');
  }
  if (texts.length === 0) return [];

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function embedOne(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}
