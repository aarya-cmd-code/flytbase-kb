import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import askRoutes from './routes/ask.js';
import triageRoutes from './routes/triage.js';
import pipelineRoutes from './routes/pipeline.js';
import { runIngest } from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// re-run ingestion on demand (e.g. after the hackathon issues a follow-up
// dataset update) without redeploying — this is what satisfies "reflect an
// updated corpus without a full manual rebuild"
app.post('/api/ingest', async (_req, res) => {
  try {
    const result = await runIngest();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ingest] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', askRoutes);
app.use('/api', triageRoutes);
app.use('/api', pipelineRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
