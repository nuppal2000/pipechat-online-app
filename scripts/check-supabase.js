// Read-only contract check. Never changes the selected provider or creates users.
const { createSupabaseBackend } = require('../lib/supabase-backend.js');

async function main() {
  const backend = createSupabaseBackend({
    url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
  await backend.check({ requireDatabase: true });
  console.log('PASS: Supabase database health and pipechat-supabase-v1 contract.');
  console.log('This read-only check does not prove account isolation, writes, concurrency, backups or restoration.');
  console.log('The live app provider was not changed. Complete the migration checklist before switching.');
}
main().catch(() => {
  console.error('FAIL: Supabase contract check. Verify the project URL, publishable key and applied migration privately.');
  process.exitCode = 1;
});
