import { Router } from 'express';
import { supabase } from '../db.js';
import { retrieveCustomerChunks } from '../retrieve.js';
import { fetchLiveDocs } from '../docs_fetch.js';
import { synthesizeAnswer } from '../llm.js';

const router = Router();

// Cheap heuristic to decide which source(s) a question likely needs, purely
// to control which retrieval calls we bother making. The LLM synthesis step
// still gets whatever context we fetched and only cites what's actually
// relevant, so a wrong guess here just costs an unnecessary fetch, not
// answer quality.
function decideSources(question) {
  const q = question.toLowerCase();
  const docsSignals = ['docs', 'documentation', 'support', 'release', 'feature', 'how do i', 'how to', 'does flytbase', 'supported', 'api', 'sdk', 'setup', 'configure'];
  const customerSignals = ['account', 'customer', 'client', 'arr', 'tier', 'health', 'issue', 'ticket', 'meeting', 'task', 'requested', 'industry', 'region', 'owner'];
  const wantsDocs = docsSignals.some((s) => q.includes(s));
  const wantsCustomer = customerSignals.some((s) => q.includes(s));
  // default to both when unclear — combined questions are the whole point of the demo
  if (!wantsDocs && !wantsCustomer) return { customer: true, docs: true };
  return { customer: wantsCustomer || !wantsDocs, docs: wantsDocs || !wantsCustomer };
}

router.post('/ask', async (req, res) => {
  const { question, forceCustomer, forceDocs } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question (string) is required' });
  }

  try {
    const decision = decideSources(question);
    const useCustomer = forceCustomer ?? decision.customer;
    const useDocs = forceDocs ?? decision.docs;

    const [customerChunks, docChunks] = await Promise.all([
      useCustomer ? retrieveCustomerChunks(question) : Promise.resolve([]),
      useDocs ? fetchLiveDocs(question) : Promise.resolve([])
    ]);

    const answer = await synthesizeAnswer({ question, customerChunks, docChunks });

    const contradictionFlag = /\bnote:\b.*contradict/i.test(answer) || /contradict/i.test(answer);

    await supabase.from('query_log').insert({
      question,
      used_customer_data: useCustomer && customerChunks.length > 0,
      used_docs: useDocs && docChunks.length > 0,
      sources: {
        customer: customerChunks.map((c) => c.id),
        docs: docChunks.map((d) => d.url)
      },
      contradiction_flag: contradictionFlag
    });

    res.json({
      answer,
      sources: {
        customer: customerChunks.map((c) => ({ id: c.id, account_name: c.account_name, similarity: c.similarity })),
        docs: docChunks.map((d) => ({ url: d.url, title: d.title, fetchedAt: d.fetchedAt }))
      },
      contradictionFlag
    });
  } catch (err) {
    console.error('[ask] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bonus — "which questions get asked most often"
router.get('/ask/usage', async (_req, res) => {
  const { data, error } = await supabase
    .from('query_log')
    .select('question, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  for (const row of data) {
    const key = row.question.trim().toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([question, count]) => ({ question, count }));

  res.json({ top, totalLogged: data.length });
});

export default router;
