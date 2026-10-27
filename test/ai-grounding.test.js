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

const renameResult=()=>({crmAction:{action:'workspace_plan',steps:[{op:'select_records',id:'source'},{op:'update_records',id:'rename',selection:'source',assignments:[{field:'name',operation:'set',value:'Replacement'}]}]}});
function identityFixture(command,names=['QA26 Saffron Studio','Control Alex01','Control Blair02']){
  return {userCommand:command,pipeline:{primaryField:'name',fields:{name:'Account Name',owner:'Owner',notes:'Notes'},
    records:names.map((name,i)=>({id:i+1,name})),todoView:[]}};
}

test('rename grounding resolves the exact saved source instead of the new name shared with other records',()=>{
  const p=identityFixture('Rename QA26 Saffron Studio to Control Saffron Studio. Keep every other value unchanged.'),before=structuredClone(p),result=renameResult();
  assert.deepEqual(G.identityContext(p).references,[{phrase:'qa26 saffron studio',candidates:[{id:1,name:'QA26 Saffron Studio'}],selection:'single_record'}]);
  assert.equal(G.guardIdentity(p,result),result);assert.deepEqual(p,before);
  assert.match(G.instructions,/SOURCE VERSUS VALUE/);assert.match(G.instructions,/original user command still supplies every replacement value/);
});

test('literal-value exclusion is name independent and handles quotes, embedded to, conjunctions and punctuation in sources',()=>{
  for(const [source,target,command] of [
    ['Cedar Workshop','Shared Workshop','Please rename Cedar Workshop to Shared Workshop'],
    ['Route to Market','Shared Route','Rename Route to Market to Shared Route'],
    ['Research and Design','Shared Research','Rename Research and Design to Shared Research'],
    ['Smith, Inc.','Shared Smith','Rename Smith, Inc. to Shared Smith'],
    ['Cedar Workshop','Shared and delete Acorn','Rename "Cedar Workshop" to "Shared and delete Acorn". Keep everything else unchanged.'],
    ['Cedar Workshop','Shared Group',"Rename 'Cedar Workshop' as 'Shared Group'"],
    ['Cedar Workshop','Shared Group','Rename \u201cCedar Workshop\u201d to \u201cShared Group\u201d']
  ]){
    const p=identityFixture(command,[source,'Shared East','Shared West','Acorn East','Acorn West']),result=renameResult();
    result.crmAction.steps[1].assignments[0].value=target;
    const refs=G.identityContext(p).references;
    assert.equal(refs.length,1,command);assert.deepEqual(refs[0].candidates.map(row=>row.id),[1],command);
    assert.equal(G.guardIdentity(p,result),result,command);
  }
});

test('named-field assignment values never masquerade as selectors in either field ordering',()=>{
  for(const command of ['Set Cedar Workshop owner to Shared','Update Cedar Workshop notes to Shared',
    'Change the Owner of Cedar Workshop to Shared','Set Notes for Cedar Workshop to "Shared and delete Acorn"',
    'Set Cedar Workshop Account Name = Shared Workshop','Change the name of Cedar Workshop to Shared Workshop']){
    const p=identityFixture(command,['Cedar Workshop','Shared East','Shared West','Acorn East','Acorn West']),result=renameResult();
    assert.deepEqual(G.identityContext(p).references.map(ref=>ref.candidates.map(row=>row.id)),[[1]],command);
    assert.equal(G.guardIdentity(p,result),result,command);
  }
  const p=grounded('Set Atlas Field Services owner to Northstar');p.pipeline.records.push({id:4,account:'Northstar West'});
  assert.equal(G.guardIdentity(p,renameResult()).crmAction.action,'workspace_plan');
});

test('partial and duplicate exact rename sources still require identity clarification regardless of the replacement',()=>{
  for(const [command,names] of [
    ['Rename Acorn to Shared Studio',['Acorn East','Acorn West','Shared East','Shared West']],
    ['Rename Acorn Studio to Shared Studio',['Acorn Studio','Acorn Studio','Shared East','Shared West']],
    ['Rename one of the Acorn accounts to Shared Studio',['Acorn East','Acorn West','Shared East','Shared West']]
  ]){
    const p=identityFixture(command,names),result=renameResult();
    const actual=G.guardIdentity(p,result);assert.equal(actual.crmAction.action,'clarify',command);
    assert.match(actual.crmAction.question,/Acorn/);assert.doesNotMatch(actual.crmAction.question,/Shared/);
  }
});

test('assignment masking does not remove additional target clauses or ambiguities',()=>{
  for(const command of ['Rename Cedar Workshop to Shared Studio and delete Acorn',
    'Rename Cedar Workshop to Shared Studio; update Acorn notes to Hello',
    'Rename Cedar Workshop to Shared Studio. Set Acorn owner to Shared',
    'Rename Cedar Workshop to Shared Studio\nRename Acorn to Another Name',
    'Rename Cedar Workshop to Shared Studio, Acorn to Another Name',
    'Rename Cedar Workshop to Shared Studio & Acorn to Another Name',
    'Rename Cedar Workshop to Shared Studio and Acorn to Another Name']){
    const p=identityFixture(command,['Cedar Workshop','Shared East','Shared West','Acorn East','Acorn West']);
    const guarded=G.guardIdentity(p,renameResult());assert.equal(guarded.crmAction.action,'clarify',command);
    assert.match(guarded.crmAction.question,/Acorn/,command);
  }
  const p=identityFixture('Rename Cedar Workshop to Shared Studio and rename Birch Workshop to Shared Birch',
    ['Cedar Workshop','Birch Workshop','Shared East','Shared West']);
  assert.deepEqual(G.identityContext(p).references.map(ref=>ref.candidates[0].id),[1,2]);
});

test('other-record values and relationship endpoints retain grounding and model output cannot suppress a source',()=>{
  const names=['Cedar Workshop','Shared East','Shared West'];
  for(const command of ['Move Cedar Workshop to Shared','Link Cedar Workshop to Shared','Merge Cedar Workshop with Shared',
    'Set Cedar Workshop owner to the same owner as Shared','Change Notes of Cedar Workshop to notes from Shared',
    "Rename Cedar Workshop to Shared's name",
    'Rename Cedar Workshop to the name of Shared','Rename Missing Source to Shared Studio',
    'Rename Cedar Workshop to Shared Studio delete Shared']){
    const p=identityFixture(command,names);
    assert(G.identityContext(p).references.some(ref=>ref.phrase==='shared'&&ref.candidates.length===2),command);
  }
  const p=identityFixture('Rename Acorn to Cedar Workshop',['Acorn East','Acorn West','Cedar Workshop']);
  const guessed=renameResult();guessed.crmAction.steps[1].assignments[0].value='Acorn';
  assert.equal(G.guardIdentity(p,guessed).crmAction.action,'clarify');
});

test('rename identity keeps existing cohort and pending clarification contracts',()=>{
  const p=identityFixture('Rename all Acorn accounts to Shared Studio',['Acorn East','Acorn West','Shared East','Shared West']);
  assert.equal(G.identityContext(p).references[0].selection,'all_matching_candidates');
  p.userCommand='Rename Acorn to Shared Studio';const question=G.guardIdentity(p,renameResult()).crmAction;
  p.pendingClarification={originalCommand:p.userCommand,question:question.question,options:question.clarificationOptions};p.userCommand='2';
  const context=G.identityContext(p);assert.equal(context.selectedId,2);assert(!context.references.some(ref=>ref.phrase==='shared'));
  const result=renameResult();assert.equal(G.guardIdentity(p,result),result);
});

test('record assignment parsing is bounded and keeps unrecognized commands under the existing guard',()=>{
  for(const command of ['Rename Cedar Workshop to Shared '+'.'.repeat(17000),
    'Rename Cedar Workshop to Shared '+Array(4200).fill('x').join(' '),
    'For Cedar Workshop, set an unspecified property to Shared']){
    const p=identityFixture(command,['Cedar Workshop','Shared East','Shared West']);
    assert(G.identityContext(p).references.some(ref=>ref.phrase==='shared'&&ref.candidates.length===2));
  }
});
