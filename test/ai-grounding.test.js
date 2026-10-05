const test = require('node:test'), assert = require('node:assert/strict');
const G = require('../lib/ai-grounding'), Router = require('../lib/model-router');
const Core = require('../public/pipeline-core'), Schema = require('../public/table-schema');
const schema = Schema.legacySchema();
const current = {updatedAt:'version-1',tableSchema:schema,customFields:[],todoCards:[],deals:[
  {id:1,account:'Atlas Field Services',owner:'Sarah',value:12000,stage:'Warm'},
  {id:2,account:'Atlas Maintenance Services',owner:'Ravi',value:34000,stage:'Won'},
  {id:3,account:'Northstar Design',owner:'Sarah',value:8000,stage:'Warm'}
]};
function grounded(command, extra={}) {return G.prepare({userCommand:command,...extra}, structuredClone(current),{name:'Sarah'},null);}

test('both model tiers are explicit; simple operations use mini and compound requests use 5.2',()=>{
  assert.deepEqual(Router.models({}),{simple:'gpt-5.4-mini',complex:'gpt-5.2'});
  for(const command of ['show accounts owned by Sarah','set Northstar Design priority to High','show total value by owner','add jon to atlas as the primary contact'])assert.equal(Router.route({userCommand:command}).tier,'simple',command);
  for(const command of ['Add Risk Level and populate it by deal value','Take the two highest-value open deals and set priority High; for each create a task due two business days from today','Create two graphs of value and count','Audit every record for missing owner and stage'])assert.equal(Router.route({userCommand:command}).tier,'complex',command);
  assert.equal(Router.route({userCommand:'a',pendingClarification:{originalCommand:'Create two graphs and compare them'}}).tier,'complex');
  assert.equal(Router.route({csvImport:{}}).tier,'complex');
  assert.equal(Router.route({userCommand:'Set both Atlas accounts Primary Contact to Jon. Preview only.'}).reason,'bulk_mutation');
  assert.equal(Router.route({userCommand:'Show all accounts owned by Sarah'}).tier,'simple');
  assert(Router.needsEscalation({crmAction:{action:'workspace_plan'}}));
  assert(!Router.needsEscalation({crmAction:{action:'workspace_plan',steps:[{op:'select_records',relatedTasks:'any'},{op:'update_records',assignments:[{}]}]}}));
  assert(Router.needsEscalation({crmAction:{action:'workspace_plan',steps:[{op:'update_tasks'},{op:'update_tasks'}]}}));
  assert(!Router.needsEscalation({crmAction:{action:'query_records'}}));
});

test('every request replaces forged browser rows, fields, cards and report statistics with server data',()=>{
  const p=grounded('show accounts',{pipeline:{records:[{id:99,account:'Forged'}],fields:{secret:'Secret'},primaryField:'fake',todoView:[{title:'Forged'}],dashboard:{displayed:[{count:999}]}}});
  assert.deepEqual(p.pipeline.records,current.deals);assert.equal(p.pipeline.primaryField,'account');assert(!p.pipeline.fields.secret);
  assert.deepEqual(p.pipeline.todoView,[]);assert.deepEqual(p.pipeline.dashboard.displayed,[]);
  assert.deepEqual(p.pipeline.visibleIds,[1,2,3]);
  assert.throws(()=>grounded('update',{pipeline:{workspaceVersion:'old'}}),/workspace changed/);
});

test('current-state grounding excludes old cell history and supplies a schema-based open predicate',()=>{
  const data=structuredClone(current);data.deals[0].history=['Stage changed from Won to Warm'];data.deals[0].internalMetadata='not a cell';
  const p=G.prepare({userCommand:'update open deals'},data,{},null);
  assert.equal(p.pipeline.records[0].history,undefined);assert.equal(p.pipeline.records[0].internalMetadata,undefined);assert.equal(p.pipeline.records[0].stage,'Warm');
  assert.deepEqual(p.pipeline.semanticScopes.open,{field:'stage',label:'Stage',operator:'in',values:['Discovery','Warm','Proposal Sent','Negotiation','At Risk'],excludeBlank:true});
  assert.equal(data.deals[0].history.length,1);
});

test('server recomputes table filters and linked task titles from current primary values',()=>{
  const data=structuredClone(current);data.todoCards=[{id:'todo_test',recordId:1,status:'To Do',nextAction:'Call',notes:'',dueDate:''}];
  const p=G.prepare({pipeline:{tableView:{filter:{field:'owner',operator:'equals',value:'Sarah'},visibleIds:[2]}}},data,{name:'Sarah'},null);
  assert.deepEqual(p.pipeline.visibleIds,[1,3]);assert.equal(p.pipeline.todoView[0].title,'Atlas Field Services');
});

test('named account grounding keeps each actual linked task ID distinct',()=>{
  const data=structuredClone(current);data.todoCards=[1,2].map(id=>({id:'todo_'+id,recordId:id,status:'To Do',nextAction:'Call',notes:'',dueDate:''}));
  const p=G.prepare({userCommand:'Set Atlas Field Services task to today and Atlas Maintenance Services task to tomorrow'},data,{},null);
  const matches=G.identityContext(p).linkedTasks;
  assert.equal(matches.length,2);
  assert.deepEqual(matches.map(ref=>ref.candidates[0].tasks[0].id),['todo_1','todo_2']);
});

test('saved single charts and multiple graphs retain their scope with recomputed statistics',()=>{
  const spec={version:1,title:'Value by owner',chart:'bar',scope:'all',groupBy:'owner',bucket:'none',splitBy:null,where:[],measures:[{label:'Value',metric:'sum',field:'value',where:[]}],sort:'value_desc',limit:null};
  const state={report:{...spec,dashboard:null},view:'dashboard',focus:{kind:'report'}};
  const p=G.prepare({userCommand:'Which owner is highest?'},structuredClone(current),{},state);
  assert.equal(p.pipeline.dashboard.displayed[0].recordCount,3);
  assert.equal(p.pipeline.dashboard.displayed[0].summaries[0].value,54000);
  assert.equal(p.currentReport.dashboard,undefined);
  const board={version:1,elements:[{id:'one',spec,visibleIds:[]}],sharedFilters:[],activeId:'one'};
  const q=G.prepare({pipeline:{dashboard:{displayed:[{value:999}]}}},structuredClone(current),{},{...state,report:{...spec,dashboard:board}});
  assert.equal(q.pipeline.dashboard.displayed[0].id,'one');assert.equal(q.pipeline.dashboard.displayed[0].summaries[0].value,54000);
});

test('Atlas ambiguity precedes contact clarification even when model guessed a specific account',()=>{
  const p=grounded('add jon to atlas as the primary contact');
  const result=G.guardIdentity(p,{crmAction:{action:'clarify',question:'Jon or Jon Bell?'}});
  assert.match(result.crmAction.question,/Atlas Field Services/);assert.match(result.crmAction.question,/Atlas Maintenance Services/);
  assert(!result.crmAction.question.includes('Jon Bell'));
  assert.equal(G.guardIdentity(p,{crmAction:{action:'update_records',changes:[{recordMatch:'Atlas Field Services',field:'notes',value:'Jon'}]}}).crmAction.action,'clarify');
});

test('different partial names, duplicate exact names and primary-column changes use the same guard',()=>{
  const data=structuredClone(current);data.tableSchema.columnOrder=['owner','account','stage','value','close','next','follow','activity','health','notes'];
  const p=G.prepare({userCommand:'update Sarah notes to hello'},data,{},null);
  assert.equal(p.pipeline.primaryField,'owner');assert.equal(G.guardIdentity(p,{crmAction:{action:'update_records'}}).crmAction.action,'clarify');
  const refs=G.references('edit Northstar', [{id:4,name:'Northstar East'},{id:5,name:'Northstar West'}],'name');assert.equal(refs[0].candidates.length,2);
});

test('exact names, explicit cohorts, cancellation and numbered clarification replies remain usable',()=>{
  const edit={crmAction:{action:'update_records'}};
  assert.equal(G.guardIdentity(grounded('set Atlas Field Services owner to Sarah'),edit),edit);
  assert.equal(G.guardIdentity(grounded('set both Atlas accounts owner to Sarah'),edit),edit);
  assert.equal(G.identityContext(grounded('set both Atlas accounts owner to Sarah')).references[0].selection,'all_matching_candidates');
  assert.equal(G.identityContext(grounded('set Atlas owner to Sarah')).references[0].selection,'single_record');
  const original=grounded('add jon to atlas as the primary contact'),question=G.guardIdentity(original,edit).crmAction;
  const pending={originalCommand:original.userCommand,question:question.question,options:question.clarificationOptions};
  assert.equal(G.guardIdentity(grounded('2',{pendingClarification:pending}),edit),edit);
  assert.equal(G.identityContext(grounded('2',{pendingClarification:pending})).selectedId,2);
  const next={...pending,question:'What contact?',options:null,answers:[{question:pending.question,answer:'2'}]};
  assert.equal(G.identityContext(grounded('Jon',{pendingClarification:next})).selectedId,2);
  assert.equal(G.guardIdentity(grounded('set Atlas owner to Sarah and keep all other data'),edit).crmAction.action,'clarify');
  assert.equal(G.guardIdentity(grounded('no, leave it unchanged',{pendingClarification:pending}),{crmAction:null}).crmAction,null);
});
