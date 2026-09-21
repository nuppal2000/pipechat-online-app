const { createXanoBackend } = require('../lib/xano-backend.js');

async function main() {
  const backend = createXanoBackend({ baseUrl: process.env.XANO_API_BASE_URL, serverKey: process.env.XANO_SERVER_KEY });
  const result = await backend.check();
  console.log(`Xano contract check passed: ${result.contract}`);
  console.log('This verifies the health contract, not database isolation or concurrency. Complete the live acceptance checklist before switching real users.');
  if (process.argv.includes('--account')) {
    if (!process.env.XANO_TEST_EMAIL || !process.env.XANO_TEST_PASSWORD) throw new Error('Set XANO_TEST_EMAIL and XANO_TEST_PASSWORD for a dedicated test account.');
    const {token} = await backend.authenticate('login',{email:process.env.XANO_TEST_EMAIL,password:process.env.XANO_TEST_PASSWORD});
    try {
      const crm = await backend.readCrm(token);
      const usage = await backend.readUsage(token);
      console.log(`Authenticated reads passed: ${crm.deals.length} deals; ${usage.used}/${usage.limit} chats used.`);
      console.log('No CRM records or chat counters were changed.');
    } finally { await backend.logout(token); }
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
