// Offline HTTP regression: no real provider request or credential is permitted.
if (process.env.NODE_ENV !== 'test' || process.env.SUPABASE_URL !== 'https://pipechat-test.supabase.co') throw new Error('Offline fixture only.');
const http = require('node:http');
let authCalls = 0, server;
global.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://pipechat-test.supabase.co') throw new Error('Offline destination denied.');
  if (url.pathname === '/rest/v1/rpc/pipechat_health') return Response.json({ok:true,contract:'pipechat-supabase-v1',database:'ok',schemaVersion:1});
  if (url.pathname === '/auth/v1/token' && url.search === '?grant_type=refresh_token' && init.method === 'POST') {
    authCalls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return Response.json({code:'refresh_token_not_found',message:'Synthetic revoked session'},
      {status:400,headers:{'x-supabase-api-version':'2024-01-01'}});
  }
  throw new Error('Unexpected offline request.');
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  if (server || args[0] !== 0 || args[1] !== '127.0.0.1') throw new Error('Ephemeral loopback only.');
  server = this;
  this.once('listening', () => process.send?.({type:'test-ready',port:this.address().port}));
  return listen.apply(this,args);
};
process.on('message', message => {
  if (message?.type === 'test-count') process.send?.({type:'test-count',authCalls});
  if (message?.type === 'test-stop') {
    server?.closeAllConnections();
    if (server) server.close(()=>process.exit(0));
    else process.exit(0);
  }
});
