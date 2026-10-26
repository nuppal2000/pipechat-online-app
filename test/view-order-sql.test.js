'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('@electric-sql/pglite');
const Core = require('../public/business-workspace');

test('026 cleanup preserves member/view ordinality, existing privilege boundaries and non-expansion of access', {timeout:120000}, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const read = name => fs.readFile(path.join(__dirname,'../db',name),'utf8');
  await db.exec(await read('tests/mock-supabase.sql')); await db.exec('alter table auth.users add column email text');
  const files = (await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(name => /^\d{3}-.*\.sql$/.test(name)).sort();
  for (const file of files.filter(name => name < '014')) await db.exec(await read('migrations/' + file));
  const functionSecurity = async () => (await db.query("select proacl,prosecdef,proconfig from pg_proc where oid='pipechat.business_primary_changed()'::regprocedure")).rows;
  const beforeSecurity = await functionSecurity(), migration = await read('migrations/026-view-order.sql');
  assert.doesNotMatch(migration.replace(/--[^\n]*/g,''), /\b(?:grant|revoke)\s|insert\s+into\s+pipechat\.business_grants/i);
  await db.exec(migration); assert.deepEqual(await functionSecurity(),beforeSecurity);
  await db.exec(migration); assert.deepEqual(await functionSecurity(),beforeSecurity);
  async function user() {
    const value = {id:randomUUID(),session_id:randomUUID(),email:randomUUID() + '@example.test'};
    await db.query('insert into auth.users(id,email) values($1,$2)',[value.id,value.email]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[value.session_id,value.id]); return value;
  }
  async function rpc(user, name, args = []) {
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user.id,session_id:user.session_id,role:'authenticated'})]);
    await db.exec('set role authenticated');
    try { return (await db.query(`select public.${name}(${args.map((_,i) => '$' + (i + 1)).join(',')}) result`,args)).rows[0].result; }
    finally { await db.exec('reset role'); }
  }
  const owner = await user(), viewer = await user(), recordViewer = await user(), outsider = await user();
  const get = (user = owner, id = null) => rpc(user,'business_workspace_get',[id]);
  const write = s => rpc(owner,'pipechat_write_workspace_v2',[s.deals,s.customFields,s.tableSchema,s.updatedAt,s.todoCards]);
  let legacy = await rpc(owner,'pipechat_read_workspace');
  legacy = await write({...legacy,deals:[],todoCards:[],tableSchema:{status:'ready',useCase:'Other',title:'Records',recordLabel:'Row',description:'',
    fields:[{id:'f_name',name:'Name',type:'text',role:'primary',options:[]}]}});
  legacy = await write({...legacy,deals:[1,2,3,4].map(id => ({id,f_name:'Row ' + id,history:[],activity:'',health:''}))});
  let snapshot = await get(); const workspaceId = snapshot.workspaceId, ref = id => Core.legacyId(workspaceId,id);
  const entityId = 'ent_' + randomUUID(), viewIds = [1,2,3,4].map(() => 'view_' + randomUUID());
  const state = Core.empty();
  state.entityTypes = [{id:'contact',name:'Contact',fields:[{id:'name',name:'Name',type:'text',required:true,options:[]}]}];
  state.entities = [{id:entityId,typeId:'contact',values:{name:'Surviving entity'}}];
  state.relationshipTypes = [{id:'linked',name:'Linked',fromType:'contact',toType:'primary',cardinality:'many_to_many'}];
  state.relationships = [2,3].map(id => ({id:'lnk_' + randomUUID(),typeId:'linked',fromId:entityId,toId:ref(id)}));
  state.views = [
    {id:viewIds[0],name:'Mixed ordered',entityIds:[ref(3),ref(2),entityId,ref(1),ref(4)]},
    {id:viewIds[1],name:'Reverse ordered',entityIds:[ref(4),ref(1),ref(2)]},
    {id:viewIds[2],name:'Empty',entityIds:[]}, {id:viewIds[3],name:'Removed only',entityIds:[ref(2)]}
  ];
  snapshot = await rpc(owner,'business_workspace_cas',[workspaceId,snapshot.version,state,snapshot.primary.updatedAt]);
  await rpc(owner,'business_workspace_share',[workspaceId,viewer.email,'view',viewIds[0],'viewer',snapshot.version]); snapshot = await get();
  await rpc(owner,'business_workspace_share',[workspaceId,recordViewer.email,'record',ref(2),'viewer',snapshot.version]); snapshot = await get();
  const grants = async () => (await db.query('select * from pipechat.business_grants where workspace_id=$1 order by user_id,scope,resource_id',[workspaceId])).rows;
  const beforeGrants = await grants(), initial = structuredClone(snapshot);
  await t.test('row reorder/value updates do not reorder static IDs or bump business version', async () => {
    legacy = await write({...legacy,deals:[legacy.deals[3],legacy.deals[2],legacy.deals[0],{...legacy.deals[1],f_name:'Changed cell'}]});
    snapshot = await get(); assert.deepEqual(snapshot.state,initial.state); assert.equal(snapshot.version,initial.version);
    assert.deepEqual(await grants(),beforeGrants);
    assert.deepEqual((await get(viewer,workspaceId)).state.views[0].entityIds,initial.state.views[0].entityIds);
  });
  await t.test('deletion prunes exactly the missing IDs while retaining order, empty views and prior grant revocation', async () => {
    const prior = snapshot;
    legacy = await write({...legacy,deals:legacy.deals.filter(row => row.id !== 2)}); snapshot = await get();
    assert.deepEqual(snapshot.state.views.map(view => view.id),viewIds);
    assert.deepEqual(snapshot.state.views.map(view => view.entityIds),[[ref(3),entityId,ref(1),ref(4)],[ref(4),ref(1)],[],[]]);
    assert.deepEqual(snapshot.state.entities,initial.state.entities);
    assert.deepEqual(snapshot.state.relationships,initial.state.relationships.filter(link => link.toId !== ref(2)));
    assert.equal(snapshot.version,prior.version + 1);
    assert.deepEqual(await grants(),beforeGrants.filter(grant => grant.resource_id !== ref(2)));
    assert.deepEqual((await get(viewer,workspaceId)).state.views[0].entityIds,snapshot.state.views[0].entityIds);
    await assert.rejects(() => get(recordViewer,workspaceId),error => error.code === 'PT403');
    await assert.rejects(() => rpc(owner,'business_workspace_cas',[workspaceId,prior.version,prior.state,prior.primary.updatedAt]),error => error.code === 'PT409');
    assert.deepEqual(await get(),snapshot);
  });
  await t.test('reintroduced IDs never revive removed view members or record grants', async () => {
    const prior = snapshot;
    legacy = await write({...legacy,deals:[{id:2,f_name:'New row two',history:[],activity:'',health:''},...legacy.deals]});
    snapshot = await get(); assert.deepEqual(snapshot.state,prior.state); assert.equal(snapshot.version,prior.version);
    assert.deepEqual(await grants(),beforeGrants.filter(grant => grant.resource_id !== ref(2)));
    await assert.rejects(() => get(outsider,workspaceId),error => error.code === 'PT403');
    await assert.rejects(() => get(recordViewer,workspaceId),error => error.code === 'PT403');
  });
  await t.test('complete primary deletion keeps only typed IDs without adding access or changing view order', async () => {
    legacy = await write({...legacy,deals:[]}); snapshot = await get();
    assert.deepEqual(snapshot.state.views.map(view => view.id),viewIds);
    assert.deepEqual(snapshot.state.views.map(view => view.entityIds),[[entityId],[],[],[]]);
    assert.deepEqual(snapshot.state.relationships,[]);
    assert.deepEqual(await grants(),beforeGrants.filter(grant => grant.resource_id !== ref(2)));
    assert.deepEqual(await functionSecurity(),beforeSecurity);
  });
});
