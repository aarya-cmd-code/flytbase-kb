import fs from 'node:fs';

function splitRow(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

function parseTable(mdText) {
  const lines = mdText.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]).map((h) => h.toLowerCase());
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => (row[h] = cells[idx]));
    rows.push(row);
  }
  return rows;
}

function money(str) {
  if (!str) return 0;
  return Number(str.replace(/[$,]/g, '')) || 0;
}

function list(str) {
  if (!str) return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

export function parseAccounts(path) {
  const rows = parseTable(fs.readFileSync(path, 'utf8'));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    industry: r.industry,
    region: r.region,
    tier: r.tier,
    health: r.health,
    arr: money(r.arr),
    owner: r.owner,
    devices: list(r.devices)
  }));
}

export function parseIssues(path) {
  const rows = parseTable(fs.readFileSync(path, 'utf8'));
  return rows.map((r) => ({
    id: r.id,
    account_name: r.account,
    category: r.category,
    status: r.status,
    title: r.title
  }));
}

export function parseFeatureRequests(path) {
  const rows = parseTable(fs.readFileSync(path, 'utf8'));
  return rows.map((r) => ({
    id: 'fr-' + slugify(r.title),
    title: r.title,
    product_area: r['product area'],
    status: r.status,
    accounts: list(r['accounts requesting']),
    mentions: Number(r.mentions) || 0,
    revenue_impact: money(r['est. revenue impact'])
  }));
}

export function parseTasks(path) {
  const rows = parseTable(fs.readFileSync(path, 'utf8'));
  return rows.map((r) => ({
    id: r.id,
    account_name: r.account,
    title: r.title,
    assignee: r.assignee,
    priority: r.priority,
    status: r.status,
    due: r.due || null
  }));
}

export function parseMeetingNotes(path) {
  const text = fs.readFileSync(path, 'utf8');
  const blocks = text.split(/^## /m).slice(1);
  return blocks.map((block) => {
    const idMatch = block.match(/^(MTG-\d+):\s*(.+)/);
    const topic = block.match(/\*\*Topic:\*\*\s*(.+)/);
    const attendees = block.match(/\*\*Attendees:\*\*\s*(.+)/);
    const date = block.match(/\*\*Date:\*\*\s*(.+)/);
    const actionItemsBlock = block.split(/\*\*Action Items:\*\*/)[1] || '';
    const actionItems = [...actionItemsBlock.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
    return {
      id: idMatch ? idMatch[1] : null,
      account_name: idMatch ? idMatch[2].trim() : null,
      topic: topic ? topic[1].trim() : '',
      attendees: attendees ? list(attendees[1]) : [],
      meeting_date: date ? date[1].trim() : null,
      action_items: actionItems
    };
  }).filter((m) => m.id);
}
