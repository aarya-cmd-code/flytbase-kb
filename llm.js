import 'dotenv/config';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callClaude({ system, messages, max_tokens = 1024 }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return text;
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------------------------------------------------------------
// Problem #3 — triage classifier
// ---------------------------------------------------------------
const ISSUE_TAXONOMY = ['Bug', 'Support', 'Question', 'Implementation'];

export async function triageRawText(rawText, accountName) {
  const system = `You are the triage agent for FlytBase's Solutions Engineering team.
Classify raw customer text (a call note, KB entry, or support message) into exactly one of:
- "feature_request": the customer is asking for new/changed product capability
- "bug": something is broken or behaving incorrectly
- "support": general questions, implementation/onboarding issues, or account/billing questions
  (this bucket covers the real issue taxonomy's Support, Question, and Implementation categories: ${ISSUE_TAXONOMY.join(', ')})

Route it to the owning team:
- feature_request -> "product"
- bug -> "engineering"
- support -> "cs"

Respond with ONLY a JSON object, no prose, no markdown fences:
{"type": "feature_request"|"bug"|"support", "team": "product"|"engineering"|"cs", "title": "<8-12 word summary title>", "confidence": 0.0-1.0, "reasoning": "<one sentence>"}`;

  const userMsg = `Account: ${accountName || 'unknown'}\nRaw text:\n"""${rawText}"""`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 400
  });
  return extractJson(text);
}

// ---------------------------------------------------------------
// Bonus — detect if "feedback on a shipped item" is actually a new request
// ---------------------------------------------------------------
export async function classifyFeedback(originalTitle, feedbackText) {
  const system = `A customer left feedback on a product request that has already shipped.
Original shipped request: "${originalTitle}"
Decide whether the feedback is:
- "reaction": genuine reaction/usage feedback on the shipped feature itself (praise, minor friction, confirms it works)
- "new_request": actually describes a distinct new capability or a different bug, disguised as feedback on the old one

Respond with ONLY JSON: {"classification": "reaction"|"new_request", "reasoning": "<one sentence>", "suggested_title": "<title if new_request, else null>"}`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content: `Feedback: """${feedbackText}"""` }],
    max_tokens: 300
  });
  return extractJson(text);
}

// ---------------------------------------------------------------
// Problem #2 — grounded answer synthesis over combined sources
// ---------------------------------------------------------------
export async function synthesizeAnswer({ question, customerChunks, docChunks }) {
  const system = `You are FlytBase's internal knowledge-base agent. You answer questions using ONLY the context provided below — never your own outside knowledge, and never guess.

Rules:
1. Ground every claim in a specific source. After each claim, cite the source id in brackets, e.g. [issue:ISS-0004] or [docs:https://docs.flytbase.com/...].
2. If the customer-data context and the docs context together don't contain enough information to answer, say so plainly instead of guessing.
3. If a question only needs one source type, don't force in the other.
4. If you notice a contradiction between the customer data and the docs (e.g. a feature is logged as "requested" in customer data but the docs/release notes show it already shipped), call it out explicitly in a "Note:" line.
5. Be concise. Prefer short bullet points when citing multiple records.

--- CUSTOMER DATA CONTEXT ---
${customerChunks.length ? customerChunks.map((c) => `[${c.id}] (${c.source_table}, account: ${c.account_name || 'n/a'}): ${c.content}`).join('\n\n') : '(no relevant customer records found)'}

--- LIVE DOCS CONTEXT ---
${docChunks.length ? docChunks.map((d) => `[docs:${d.url}] ${d.title}: ${d.snippet}`).join('\n\n') : '(no relevant docs pages found)'}`;

  const text = await callClaude({
    system,
    messages: [{ role: 'user', content: question }],
    max_tokens: 900
  });
  return text;
}

// ---------------------------------------------------------------
// Bonus — auto-summarized status update, pasteable into a customer channel
// ---------------------------------------------------------------
export async function summarizeStatus(request, events) {
  const system = `Write a short, friendly status update (3-5 sentences) about a product request, suitable for pasting into a customer Slack/email thread. Plain language, no internal jargon (don't say "stage" or "triage"), state the current status and what happens next.`;
  const userMsg = `Request: ${request.title}\nType: ${request.type}\nCurrent stage: ${request.stage}\nAccount: ${request.account_name}\nHistory: ${events.map((e) => `${e.event_type} ${e.from_stage || ''}->${e.to_stage || ''} ${e.detail || ''}`).join('; ')}`;
  return callClaude({ system, messages: [{ role: 'user', content: userMsg }], max_tokens: 300 });
}
