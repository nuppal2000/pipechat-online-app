'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8');
function fixture(){
  const action={action:'create_workflow',title:'Five-day follow-up'},draft={kind:'workflow-save'},nodes=new Map();
  const page={epoch:'current',messages:[{role:'user',content:'Revise timezone'},{role:'assistant',content:'The request could not be validated.'}],state:{}};
  const ctx={S:{pending:draft,sourceAction:action,clarification:{question:'Which date?'},updatedAt:'v1'},restoredProposal:null,
    chatThread:'thread',conversation:{load:async()=>page},turnAwaiting:null,restoringChat:false,threadChanging:false,
    quietTurnReply:false,applyingTurn:false,saved:0,handled:0,forgotten:0,
    $:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},
    showTurnWaiting(){},forgetTurn(){ctx.forgotten++;},paintMessage(){},renderTrust(){},updateUsage(){},
    chatState:()=>({sourceAction:ctx.S.sourceAction,clarification:ctx.S.clarification,workspaceVersion:ctx.S.updatedAt}),
    clearDraft:()=>{ctx.S.pending=null;ctx.S.sourceAction=null;ctx.S.clarification=null;ctx.restoredProposal=null;},
    saveChatState:()=>{ctx.saved++;},handleAction:async()=>{ctx.handled++;}};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function draftSignature()'),source.indexOf('  function showTurnWaiting'))+
    source.slice(source.indexOf('  async function acceptTurnResponse'),source.indexOf('  async function checkPendingTurn'))+
    ';this.accept=acceptTurnResponse;this.signature=draftSignature;',ctx);
  const reply=(status='failed',epoch='current',threadId='thread')=>({turn:{status,epoch,threadId},usage:{used:1}});
  return {ctx,page,draft,reply};
}
test('a failed durable revision dismisses the old workflow, clarification and confirm controls',async()=>{
  const {ctx,reply}=fixture();
  await ctx.accept(reply(),ctx.conversation,true);
  assert.equal(ctx.S.pending,null);assert.equal(ctx.S.sourceAction,null);assert.equal(ctx.S.clarification,null);
  assert.equal(ctx.S.history.at(-1).content,'The request could not be validated.');assert.equal(ctx.saved,1);assert.equal(ctx.handled,0);
});
test('lost-response recovery invalidates only the proposal recorded for that turn',async()=>{
  for(const status of ['failed','interrupted','cancelled']){
    const {ctx,reply}=fixture();ctx.turnAwaiting={draftSignature:ctx.signature()};
    await ctx.accept(reply(status),ctx.conversation,false);assert.equal(ctx.S.pending,null);
  }
});
test('refresh recovery clears a restored obsolete proposal using the same signature',async()=>{
  const {ctx,reply}=fixture();ctx.turnAwaiting={draftSignature:ctx.signature()};ctx.restoredProposal=ctx.chatState();ctx.S.pending=null;
  await ctx.accept(reply(),ctx.conversation,false);assert.equal(ctx.restoredProposal,null);assert.equal(ctx.S.sourceAction,null);
});
test('a changed proposal, workspace, epoch or thread is not cancelled by an older failure',async()=>{
  for(const change of ['action','workspace','epoch','thread','no-signature']){
    const {ctx,reply,draft}=fixture();ctx.turnAwaiting={draftSignature:ctx.signature()};
    if(change==='action')ctx.S.sourceAction={action:'add_field',newFieldName:'Later'};
    if(change==='workspace')ctx.S.updatedAt='v2';
    if(change==='no-signature')ctx.turnAwaiting={};
    await ctx.accept(reply('failed',change==='epoch'?'old':'current',change==='thread'?'other':'thread'),ctx.conversation,false);
    assert.equal(ctx.S.pending,draft,change);
  }
});
test('successful and pending turns preserve their existing interpretation paths',async()=>{
  const {ctx,reply,draft}=fixture();
  assert.equal(await ctx.accept({...reply(),pending:true},ctx.conversation,true),false);assert.equal(ctx.S.pending,draft);
  await ctx.accept(reply('succeeded'),ctx.conversation,true);assert.equal(ctx.handled,1);assert.equal(ctx.S.pending,draft);
});
