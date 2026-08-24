import { Router } from 'express';
import { supabase } from '../db.js';
import { triageRawText } from '../llm.js';

const router = Router();

// Demo part 1: feed a raw message, get it classified + routed + created as
// a tracked "new" item in one call.
router.post('/triage', async (req, res) => {
  const { raw_text, account_name } = req.body || {};
  if (!raw_text) return res.status(400).json({ error: 'raw_text is required' });

  try {
    const classification = await triageRawText(raw_text, account_name);

    const { data, error } = await supabase
      .from('requests')
      .insert({
        raw_text,
        title: classification.title,
        type: classification.type,
        team: classification.team,
        account_name: account_name || null,
        stage: 'new'
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await supabase.from('request_events').insert({
      request_id: data.id,
      event_type: 'stage_change',
      from_stage: null,
      to_stage: 'new',
      detail: `Triaged as ${classification.type} -> routed to ${classification.team}. Reasoning: ${classification.reasoning}`,
      visible_to: [classification.team]
    });

    res.json({ request: data, classification });
  } catch (err) {
    console.error('[triage] error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
