import { Router } from 'express';
import { supabase } from './db.js';
import { classifyFeedback, summarizeStatus } from './llm.js';

const router = Router();

const STAGES = ['new', 'in_product_review', 'in_development', 'shipped'];
const SUB_STAGES = ['in_development', 'in_testing', 'in_staging', 'in_production'];

// ---- list / single-item view (Must Have: single view per item) ----
router.get('/requests', async (req, res) => {
  const { team, stage } = req.query;
  let query = supabase.from('requests').select('*').order('created_at', { ascending: false });
  if (team) query = query.eq('team', team);
  if (stage) query = query.eq('stage', stage);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data });
});

router.get('/requests/:id', async (req, res) => {
  const { id } = req.params;
  const { data: request, error } = await supabase.from('requests').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error: 'request not found' });

  const { data: events } = await supabase
    .from('request_events')
    .select('*')
    .eq('request_id', id)
    .order('created_at', { ascending: true });

  const { data: watchers } = await supabase.from('watchers').select('*').eq('request_id', id);

  res.json({ request, events: events || [], watchers: watchers || [] });
});

// team-scoped view (bonus)
router.get('/requests/:id/team-view', async (req, res) => {
  const { id } = req.params;
  const { team } = req.query; // 'product' | 'dev'
  const { data: request, error } = await supabase.from('requests').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error: 'request not found' });

  const { data: events } = await supabase
    .from('request_events')
    .select('*')
    .eq('request_id', id)
    .order('created_at', { ascending: true });

  const teamKey = team === 'dev' ? 'engineering' : team;
  const visible = (events || []).filter(
    (e) => !e.visible_to?.length || e.visible_to.includes(team) || e.visible_to.includes(teamKey)
  );

  res.json({ request, events: visible });
});

// ---- stage progression (Must Have) ----
router.post('/requests/:id/advance', async (req, res) => {
  const { id } = req.params;
  const { to_stage, detail } = req.body || {};
  if (!STAGES.includes(to_stage)) {
    return res.status(400).json({ error: `to_stage must be one of ${STAGES.join(', ')}` });
  }

  const { data: request, error } = await supabase.from('requests').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error: 'request not found' });

  const { error: updErr } = await supabase
    .from('requests')
    .update({ stage: to_stage, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  await supabase.from('request_events').insert({
    request_id: id,
    event_type: 'stage_change',
    from_stage: request.stage,
    to_stage,
    detail: detail || null,
    visible_to: ['product', 'engineering']
  });

  res.json({ ok: true, from: request.stage, to: to_stage });
});

// bonus: finer dev sub-stages
router.post('/requests/:id/sub-stage', async (req, res) => {
  const { id } = req.params;
  const { sub_stage, bug_attached } = req.body || {};
  if (!SUB_STAGES.includes(sub_stage)) {
    return res.status(400).json({ error: `sub_stage must be one of ${SUB_STAGES.join(', ')}` });
  }
  const { error } = await supabase.from('requests').update({ sub_stage }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('request_events').insert({
    request_id: id,
    event_type: 'note',
    detail: `Moved to sub-stage ${sub_stage}${bug_attached ? ' (bug attached)' : ''}`,
    visible_to: ['engineering']
  });
  res.json({ ok: true, sub_stage });
});

// bonus: demo given / customer tried
router.post('/requests/:id/mark', async (req, res) => {
  const { id } = req.params;
  const { demo_given, customer_tried } = req.body || {};
  const update = {};
  if (demo_given !== undefined) update.demo_given = demo_given;
  if (customer_tried !== undefined) update.customer_tried = customer_tried;
  const { error } = await supabase.from('requests').update(update).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  if (demo_given !== undefined) {
    await supabase.from('request_events').insert({ request_id: id, event_type: 'demo', detail: 'Demo given to customer', visible_to: ['product', 'engineering'] });
  }
  if (customer_tried !== undefined) {
    await supabase.from('request_events').insert({ request_id: id, event_type: 'customer_tried', detail: 'Customer tried the shipped feature', visible_to: ['product', 'engineering'] });
  }
  res.json({ ok: true });
});

// ---- Must Have: shipped -> feedback -> routed back to product + dev ----
router.post('/requests/:id/feedback', async (req, res) => {
  const { id } = req.params;
  const { feedback_text } = req.body || {};
  if (!feedback_text) return res.status(400).json({ error: 'feedback_text is required' });

  const { data: request, error } = await supabase.from('requests').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error: 'request not found' });
  if (request.stage !== 'shipped') {
    return res.status(400).json({ error: `feedback can only be logged once a request is shipped (current stage: ${request.stage})` });
  }

  // log the feedback, visible to BOTH product and dev — this is the loop-back
  await supabase.from('request_events').insert({
    request_id: id,
    event_type: 'feedback',
    detail: feedback_text,
    visible_to: ['product', 'engineering']
  });

  // bonus: recognize feedback that's really a new request, and link it back
  // into the pipeline instead of leaving it as an untracked thread
  let linkedRequest = null;
  try {
    const classification = await classifyFeedback(request.title, feedback_text);
    if (classification.classification === 'new_request') {
      const { data: newReq, error: newErr } = await supabase
        .from('requests')
        .insert({
          raw_text: feedback_text,
          title: classification.suggested_title || `Follow-up on: ${request.title}`,
          type: 'feature_request',
          team: 'product',
          account_name: request.account_name,
          stage: 'new',
          linked_request_id: request.id
        })
        .select()
        .single();
      if (newErr) throw new Error(newErr.message);
      linkedRequest = newReq;

      await supabase.from('request_events').insert({
        request_id: newReq.id,
        event_type: 'note',
        detail: `Auto-created from feedback on shipped request ${request.id} ("${request.title}"). Reasoning: ${classification.reasoning}`,
        visible_to: ['product']
      });
    }
  } catch (e) {
    console.warn('[pipeline] feedback classification skipped:', e.message);
  }

  res.json({ ok: true, linkedRequest });
});

// bonus: ping-for-visibility
router.post('/requests/:id/watch', async (req, res) => {
  const { id } = req.params;
  const { watcher_name } = req.body || {};
  if (!watcher_name) return res.status(400).json({ error: 'watcher_name is required' });
  const { data, error } = await supabase.from('watchers').insert({ request_id: id, watcher_name }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, watcher: data });
});

// bonus: auto-summarized status update
router.get('/requests/:id/summary', async (req, res) => {
  const { id } = req.params;
  const { data: request, error } = await supabase.from('requests').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error: 'request not found' });
  const { data: events } = await supabase.from('request_events').select('*').eq('request_id', id).order('created_at');
  try {
    const summary = await summarizeStatus(request, events || []);
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
