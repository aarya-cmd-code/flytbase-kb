import { supabase } from './db.js';
import { embedOne } from './embeddings.js';

export async function retrieveCustomerChunks(question, matchCount = 8) {
  const queryEmbedding = await embedOne(question);
  const { data, error } = await supabase.rpc('match_doc_chunks', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    filter_account: null
  });
  if (error) throw new Error(`match_doc_chunks failed: ${error.message}`);
  return data || [];
}
