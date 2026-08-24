import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn(
    '[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
    'API calls that touch the database will fail until you configure .env'
  );
}

export const supabase = createClient(url || 'http://localhost', key || 'anon', {
  auth: { persistSession: false }
});
