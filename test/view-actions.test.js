'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Actions = require('../public/view-actions');
const Business = require('../public/business-workspace');
const Core = require('../public/pipeline-core');
const Reports = require('../public/report-engine');
const Papa = require('../public/vendor/papaparse.min');
const Sheets = require('../public/spreadsheet-import');

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const viewId = 'view_33333333-3333-4333-8333-333333333333';
const newViewId = 'view_44444444-4444-4444-8444-444444444444';
const ref = id => Business.legacyId(workspaceId, id);
const savedById = () => ({source:'saved_view', viewId});
const savedByName = () => ({source:'saved_view', viewName:'High value'});
const save = (selection = {source:'visible'}, name = 'Value > 999999 and owner nobody') => ({action:'save_view', name, selection});
const open = (selection = savedById()) => ({action:'open_view', selection});
const exporting = (selection = {source:'visible'}, columns = {source:'all'}) => ({action:'export_records', selection, columns, format:'csv'});
const selected = (...columnIds) => ({source:'selected', columnIds});
function fixture() {
  return {workspaceId, records:[
    {id:11, account:'Alpha', value:0, notes:'', owner:'Lee', history:[{secret:true}], activity:'private'},
    {id:22, account:'Beta', value:25, notes:'saved value', owner:'Pat', hidden:'never export'},
    {id:33, account:'Gamma', value:null, notes:'Visible first', owner:'Sam'}
  ], visibleIds:[33, 11], views:[{id:viewId, name:'High value', entityIds:[ref(22), ref(11)]}],
  columns:[{id:'notes', name:'Notes'}, {id:'account', name:'Account'}, {id:'value', name:'Amount'}]};
}
function snapshot(context, role = 'owner') {
  return {workspaceId, version:4, scope:'workspace', role, access:{grants:[{scope:'view', resourceId:viewId}]},
    primary:{updatedAt:'2026-10-26T12:00:00.000Z', records:context.records.map(row => ({recordId:row.id, entityId:ref(row.id), values:{...row}}))},
    state:{...Business.empty(), views:structuredClone(context.views)}};
}
function grid(body) {
  const result = Papa.parse(body, {delimiter:',', header:false, dynamicTyping:false, skipEmptyLines:false});
  assert.deepEqual(result.errors, []);
  return result.data;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function code(reasonCode) { return error => error.reasonCode === reasonCode; }

test('strict model schemas cover save/open/export without executable or access fields', () => {
  const schemas = Actions.actionSchemas();
  assert.deepEqual(schemas.map(schema => schema.properties.action.enum[0]), ['save_view','open_view','export_records']);
  function inspect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required, Object.keys(node.properties));
    }
    Object.values(node).forEach(inspect);
  }
  schemas.forEach(inspect);
  assert.deepEqual(schemas[1].properties.selection.anyOf.map(schema => schema.properties.source.enum[0]), ['saved_view','saved_view']);
  assert.doesNotMatch(JSON.stringify(schemas), /"(?:count|recordIds|entityIds|where|script|recipient|email|grant|filename|body)"/);
  schemas[0].properties.name.maxLength = 999;
  assert.equal(Actions.actionSchemas()[0].properties.name.maxLength, 120);
  for (const pattern of [/static ordered/i, /names are literal/i, /IDs AND ORDER/, /never invent record IDs or counts/i,
    /no permission grants/i, /verified persistence receipt/i, /actual visible count and order/i, /apostrophe/i, /not proof.*downloaded/i]) {
    assert.match(Actions.instructions, pattern);
  }
});

test('all supported action and selection variants validate as independent copies', () => {
  for (const selection of [{source:'visible'}, {source:'all'}, savedById(), savedByName()]) {
    for (const input of [save(selection), exporting(selection), exporting(selection, selected('value','account'))]) {
      assert.deepEqual(Actions.validateAction(input), input);
      assert.notEqual(Actions.validateAction(input).selection, input.selection);
    }
  }
  for (const input of [open(), open(savedByName())]) assert.deepEqual(Actions.validateAction(input), input);
});

test('invalid actions never allow guessed IDs, counts, filters, grants or executable selectors', () => {
  const invalid = [null, {}, {action:'share_view'}, {...save(), extra:true}, {...save(), name:''}, {...save(), name:' '},
    {...save(), name:'a'.repeat(121)}, {...save(), name:'bad\nname'}, {...save(), name:'bad\0name'},
    {...save(), name:22}, {...save(), viewId}, {...open(), count:2}, open({source:'visible'}), open({source:'all'}),
    {...exporting(), format:'xlsx'}, {...exporting(), format:'html'}, {...exporting(), filename:'x.csv'},
    {...exporting(), columns:undefined}, {...exporting(), selection:undefined}];
  for (const selection of [null, {}, {source:'filter', where:[]}, {source:'visible', count:2}, {source:'all', ids:[11]},
    {source:'saved_view'}, {source:'saved_view', viewId:'missing'}, {source:'saved_view', viewId, viewName:'High value'},
    {source:'saved_view', viewName:''}, {source:'saved_view', viewName:'High\nvalue'},
    {source:'saved_view', viewId, recordIds:[33]}, {source:'saved_view', viewId, count:999}]) invalid.push(save(selection));
  for (const input of invalid) assert.throws(() => Actions.validateAction(input));
  for (const columns of [null, {}, {source:'all', columnIds:[]}, selected(), selected('Account'), selected('account','account'),
    selected('constructor'), selected('history'), selected('id'), selected(22), selected('a'.repeat(66)),
    {source:'selected', columnIds:Array(1)}, {source:'selected', columnIds:Array.from({length:201}, (_, i) => 'f_' + i)}]) {
    assert.throws(() => Actions.validateAction(exporting({source:'all'}, columns)));
  }
});

test('save captures actual visible IDs AND ORDER without interpreting its label', () => {
  const context = fixture(), before = structuredClone(context);
  const plan = Actions.plan(save(), context, {newViewId});
  assert.equal(plan.status, 'prepared');
  assert.equal(plan.operation, 'save');
  assert.deepEqual(plan.view, {id:newViewId, name:save().name, entityIds:[ref(33), ref(11)]});
  assert.deepEqual(plan.commands, [{op:'put_view', view:plan.view}]);
  assert.deepEqual(plan.selection.recordIds, [33, 11]);
  assert.equal(plan.count, 2);
  assert.equal(plan.selection.selectionMode, 'static');
  assert.match(plan.disclosure, /not filter rules or cell values/);
  assert.equal(plan.message, undefined);
  assert.deepEqual(context, before);
});

test('save all and copy-by-name/ID preserve source order, not current visible order', () => {
  for (const [selection, ids] of [[{source:'all'}, [11,22,33]], [savedByName(), [22,11]], [savedById(), [22,11]]]) {
    const plan = Actions.plan(save(selection, '  Another name  '), fixture(), {newViewId});
    assert.deepEqual(plan.view.entityIds, ids.map(ref));
    assert.equal(plan.view.name, 'Another name');
    assert.equal(plan.count, ids.length);
  }
});

test('existing Business.prepare storage schema preserves order across persistence round trips', () => {
  const context = fixture(), current = snapshot(context), before = structuredClone(current);
  const plan = Actions.plan(save(), context, {newViewId});
  const prepared = Business.prepare(current, plan.commands);
  assert.equal(prepared.expectedVersion, 4);
  assert.equal(prepared.expectedPrimaryUpdatedAt, current.primary.updatedAt);
  const restored = Business.validate(JSON.parse(JSON.stringify(prepared.next)), {workspaceId, legacyRecordIds:[11,22,33]});
  assert.deepEqual(restored.views.at(-1), plan.view);
  const reopened = Actions.plan(open({source:'saved_view', viewId:newViewId}), {...context, views:restored.views});
  assert.deepEqual(reopened.tableView.filter, {where:[], ids:[33,11]});
  assert.deepEqual(prepared.next.views[0], context.views[0]);
  for (const key of ['entities','entityTypes','relationships','relationshipTypes','primary']) assert.deepEqual(prepared.next[key], current.state[key]);
  assert.deepEqual(current, before);
  for (const role of ['editor','viewer']) assert.throws(() => Business.prepare(snapshot(context, role), plan.commands));
  assert.throws(() => Business.prepare({...current, scope:'shared'}, plan.commands), /read-only/);
});

test('save never overwrites IDs or normalized names or expands existing view grants', () => {
  for (const name of ['High value',' HIGH  VALUE ', '\uff28igh value']) {
    assert.throws(() => Actions.plan(save({source:'visible'}, name), fixture(), {newViewId}), code('view_name_conflict'));
  }
  for (const id of [undefined, viewId, 'view_bad', 'view_' + workspaceId.toUpperCase().replace('1','A')]) {
    assert.throws(() => Actions.plan(save(), fixture(), {newViewId:id}));
  }
  const context = fixture();
  context.views = Array.from({length:100}, (_, i) => ({id:'view_' + String(i).padStart(8, '0') + '-1111-4111-8111-111111111111', name:'View ' + i, entityIds:[]}));
  assert.throws(() => Actions.plan(save(), context, {newViewId}), /100 saved views/);
  const plan = Actions.plan(save(), fixture(), {newViewId});
  assert.deepEqual(Object.keys(plan.view), ['id','name','entityIds']);
  assert.deepEqual(plan.commands.map(command => command.op), ['put_view']);
  assert.doesNotMatch(JSON.stringify(plan.commands), /grant|membership|role|recipient|email/);
});

test('open prepares exact ID filtering with all conflicting UI filters and sorting cleared', () => {
  const context = {...fixture(), filter:{value:'irrelevant'}, sort:{field:'account'}, search:'Gamma', scope:'mine'};
  for (const selection of [savedById(), savedByName()]) {
    const plan = Actions.plan(open(selection), context);
    assert.deepEqual(plan.tableView, {scope:'all', search:'', filter:{where:[], ids:[22,11]}, sort:null});
    assert.equal(plan.status, 'prepared');
    assert.equal(plan.message, undefined);
    assert.equal(plan.visibleCount, undefined);
    assert.equal(plan.selection.name, 'High value');
  }
});

test('open success is only verified after apply and actual visible IDs/count/order match', () => {
  const context = fixture(), prepared = Actions.plan(open(), context);
  prepared.count = 999; prepared.selection.count = 1000;
  for (const receipt of [undefined, {}, {applied:false, visibleIds:[22,11]}, {applied:true, visibleIds:[11,22]},
    {applied:true, visibleIds:[22]}, {applied:true, visibleIds:[22,11,33]}, {applied:true, visibleIds:[22,22]},
    {applied:true, visibleIds:['22','11']}, {applied:true, visibleIds:Array(2)}, {applied:true, visibleCount:2},
    {applied:true, visibleIds:[22,11], visibleCount:999}]) {
    assert.throws(() => Actions.verifyOpen(prepared, context, receipt), code('view_apply_failed'));
  }
  const receipt = {applied:true, visibleIds:[22,11]}, verified = Actions.verifyOpen(prepared, context, receipt);
  assert.equal(verified.status, 'applied');
  assert.equal(verified.visibleCount, 2);
  assert.deepEqual(verified.recordIds, [22,11]);
  assert.match(verified.message, /Opened "High value": 2 visible records/);
  assert.match(verified.message, /Static saved selection/);
  verified.recordIds.reverse();
  assert.deepEqual(receipt.visibleIds, [22,11]);
  for (const value of [null, Actions.plan(save(), context, {newViewId}), Actions.plan(exporting(), context)]) {
    assert.throws(() => Actions.verifyOpen(value, context, receipt));
  }
});

test('prepared open uses the existing table filter consumer, including empty selections and ordered rendering', () => {
  for (const ids of [[22,11], [33,22,11], [11], []]) {
    const context = fixture(); context.views[0].entityIds = ids.map(ref);
    const before = structuredClone(context), prepared = Actions.plan(open(), context);
    const matches = Reports.tableMatches(prepared.tableView.filter, Core, [], context.records, '2026-10-26');
    const rendered = context.records.filter(matches).sort((a, b) => prepared.tableView.filter.ids.indexOf(a.id) - prepared.tableView.filter.ids.indexOf(b.id));
    const verified = Actions.verifyOpen(prepared, context, {applied:true, visibleIds:rendered.map(row => row.id)});
    assert.deepEqual(verified.recordIds, ids);
    assert.equal(verified.visibleCount, ids.length);
    assert.deepEqual(context, before);
  }
});

test('empty visible/saved selections stay empty, never fall back to all records', () => {
  const context = fixture(); context.visibleIds = []; context.views[0].entityIds = [];
  const saved = Actions.plan(save(), context, {newViewId});
  assert.deepEqual(saved.view.entityIds, []);
  for (const selection of [{source:'visible'}, savedByName(), savedById()]) {
    const result = Actions.plan(exporting(selection), context);
    assert.equal(result.count, 0); assert.deepEqual(result.recordIds, []);
    assert.deepEqual(grid(result.artifact.body), [['Notes','Account','Amount']]);
  }
  const prepared = Actions.plan(open(), context);
  assert.equal(Actions.verifyOpen(prepared, context, {applied:true, visibleIds:[]}).visibleCount, 0);
  assert.throws(() => Actions.verifyOpen(prepared, context, {applied:true, visibleIds:[11,22,33]}));
  context.records = [];
  assert.equal(Actions.plan(exporting({source:'all'}), context).count, 0);
});

test('saved selection reads current cells but does not rerun implied name filters', () => {
  const context = fixture(); context.records[1].value = -1; context.records[0].value = 10;
  context.records.push({id:44, account:'New expensive row', value:999999});
  const result = Actions.plan(exporting(savedByName(), selected('value')), context);
  assert.deepEqual(result.recordIds, [22,11]);
  assert.deepEqual(grid(result.artifact.body), [['Amount'],['-1'],['10']]);
});

test('missing, duplicate, ambiguous, malformed and unavailable views fail closed', () => {
  const context = fixture();
  assert.throws(() => Actions.resolveSelection({source:'saved_view', viewName:'High'}, context), code('view_selection_stale'));
  assert.throws(() => Actions.resolveSelection({source:'saved_view', viewId:newViewId}, context), code('view_selection_stale'));
  const duplicate = {...context, views:[...context.views, {id:newViewId, name:' HIGH  VALUE ', entityIds:[ref(33)]}]};
  assert.throws(() => Actions.resolveSelection(savedByName(), duplicate), code('view_name_ambiguous'));
  assert.deepEqual(Actions.resolveSelection(savedById(), duplicate).recordIds, [22,11]);
  for (const views of [undefined, {}, Array(1), [...context.views, ...context.views], [{...context.views[0], count:2}],
    [{...context.views[0], entityIds:[ref(22),ref(22)]}], [{...context.views[0], entityIds:[22]}],
    [{...context.views[0], name:''}], [{...context.views[0], id:'not-a-view'}]]) {
    assert.throws(() => Actions.resolveSelection(savedById(), {...context, views}));
  }
});

test('stale/missing IDs, cross-workspace references and mixed entity views cannot produce partial results', () => {
  for (const references of [[ref(22),ref(999)], [Business.legacyId(otherWorkspace, 11)], ['legacy:' + workspaceId + ':011'],
    ['legacy:' + workspaceId + ':' + (Number.MAX_SAFE_INTEGER + 1)], ['legacy:' + workspaceId + ':-1'],
    ['bogus'], [ref(11), 'ent_55555555-5555-4555-8555-555555555555']]) {
    const context = fixture(); context.views[0].entityIds = references;
    for (const action of [open(), exporting(savedById()), save(savedById())]) assert.throws(() => Actions.plan(action, context, {newViewId}));
  }
  const context = fixture(); context.records = context.records.filter(row => row.id !== 22);
  assert.throws(() => Actions.plan(open(), context), code('view_selection_stale'));
});

test('visible and all IDs are strict canonical IDs with no fallback or model count authority', () => {
  for (const visibleIds of [undefined, null, {}, [11,11], ['11'], [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], Array(1), [11,999], Array.from({length:7001}, (_, i) => i + 1)]) {
    assert.throws(() => Actions.plan(save(), {...fixture(), visibleIds}, {newViewId}));
  }
  for (const records of [undefined, {}, [null], Array(1), [{id:11},{id:11}], [{id:'11'}], [{id:0}], [{id:1.5}], [Object.create({id:11})]]) {
    assert.throws(() => Actions.resolveSelection({source:'all'}, {...fixture(), records}));
  }
  for (const id of [null, undefined, 'bad', 'a'.repeat(36), 12]) assert.throws(() => Actions.resolveSelection({source:'all'}, {...fixture(), workspaceId:id}));
  assert.equal(Actions.resolveSelection({source:'all'}, {...fixture(), count:999, visibleCount:888}).count, 3);
  const context = fixture(); context.records.push({id:Number.MAX_SAFE_INTEGER}); context.visibleIds = [Number.MAX_SAFE_INTEGER];
  assert.deepEqual(Actions.plan(save(), context, {newViewId}).view.entityIds, [ref(Number.MAX_SAFE_INTEGER)]);
});

test('saved view capacity accepts 7000 ordered references and rejects overflow without truncation', () => {
  const context = fixture();
  context.records = Array.from({length:7000}, (_, i) => ({id:i + 1}));
  context.visibleIds = context.records.map(row => row.id).reverse();
  const prepared = Actions.plan(save(), context, {newViewId});
  assert.equal(prepared.count, 7000);
  assert.equal(prepared.view.entityIds[0], ref(7000));
  assert.equal(prepared.view.entityIds.at(-1), ref(1));
  assert.equal(Business.prepare(snapshot(context), prepared.commands).next.views.at(-1).entityIds.length, 7000);
  context.records.push({id:7001}); context.visibleIds.unshift(7001);
  assert.throws(() => Actions.plan(save(), context, {newViewId}));
  context.records.pop(); context.visibleIds.shift(); context.views[0].entityIds = [...prepared.view.entityIds, ref(7001)];
  assert.throws(() => Actions.plan(open(), context));
});

test('revalidation detects workspace, visible/all order and saved-membership changes without trusting counts', () => {
  for (const selection of [{source:'visible'}, {source:'all'}, savedById(), savedByName()]) {
    const context = fixture(), binding = Actions.resolveSelection(selection, context);
    binding.count = 9999;
    assert.equal(Actions.revalidateSelection(binding, context).count, binding.recordIds.length);
    assert.throws(() => Actions.revalidateSelection(binding, {...context, workspaceId:otherWorkspace}), code('view_selection_stale'));
    const missing = {...context, records:context.records.filter(row => row.id !== binding.recordIds[0])};
    assert.throws(() => Actions.revalidateSelection(binding, missing), code('view_selection_stale'));
    if (selection.source === 'visible') context.visibleIds.reverse();
    else if (selection.source === 'all') context.records.reverse();
    else context.views[0].entityIds.reverse();
    assert.throws(() => Actions.revalidateSelection(binding, context), code('view_selection_stale'));
  }
  const context = fixture(), binding = Actions.resolveSelection(savedById(), context);
  context.visibleIds.reverse(); context.records.reverse(); context.records[0].value = 123;
  assert.deepEqual(Actions.revalidateSelection(binding, context).recordIds, [22,11]);
  context.views[0].name = 'Renamed';
  assert.throws(() => Actions.revalidateSelection(binding, context), code('view_selection_stale'));
  for (const input of [null, {}, {...binding, version:2}, {...binding, selectionMode:'dynamic'}, {...binding, extra:true}]) {
    assert.throws(() => Actions.revalidateSelection(input, fixture()));
  }
});

test('open verification refuses a changed stored selection even if old IDs were applied', () => {
  const context = fixture(), prepared = Actions.plan(open(), context);
  context.views[0].entityIds = [ref(33)];
  assert.throws(() => Actions.verifyOpen(prepared, context, {applied:true, visibleIds:[22,11]}), code('view_selection_stale'));
});

test('CSV scopes and selected/all columns preserve requested orders and exclude hidden fields', () => {
  const context = fixture();
  for (const [selection, ids] of [[{source:'visible'}, [33,11]], [{source:'all'}, [11,22,33]], [savedById(), [22,11]], [savedByName(), [22,11]]]) {
    for (const columns of [{source:'all'}, selected('value','account'), selected('notes')]) {
      const result = Actions.plan(exporting(selection, columns), context);
      const defs = columns.source === 'all' ? context.columns : columns.columnIds.map(id => context.columns.find(column => column.id === id));
      assert.equal(result.status, 'prepared'); assert.equal(result.kind, 'export');
      assert.deepEqual(result.recordIds, ids); assert.equal(result.count, ids.length);
      assert.deepEqual(result.columnIds, defs.map(column => column.id));
      assert.deepEqual(grid(result.artifact.body), [defs.map(column => column.name), ...ids.map(id => {
        const row = context.records.find(row => row.id === id); return defs.map(column => String(row[column.id] ?? ''));
      })]);
      assert.doesNotMatch(result.artifact.body, /private|secret|never export|history/);
    }
  }
});

test('CSV quotes commas, embedded quotes, CR/LF, blanks, whitespace, false and zero without data loss', () => {
  const values = ['a,b', 'said "hello"', 'line1\nline2', 'line1\r\nline2', 'line1\rline2', '', null, undefined, 0, false, true,
    1234.5, -42, '  padded  ', '"\r\n,\"', '00123', '\u65e5\u672c\u8a9e \u00e9 \ud83d\ude80'];
  const context = fixture();
  context.records = values.map((value, index) => ({id:index + 1, account:value}));
  context.columns = [{id:'account', name:'Name, "quoted"\nheader'}];
  const result = Actions.csvArtifact(exporting({source:'all'}), context);
  assert.equal(result.artifact.mimeType, 'text/csv; charset=utf-8');
  assert.equal(result.artifact.encoding, 'utf-8');
  assert.equal(result.artifact.body[0], '\ufeff');
  assert.match(result.artifact.body, /"said ""hello"""/);
  assert.deepEqual(grid(result.artifact.body), [[context.columns[0].name], ...values.map(value => [String(value ?? '')])]);
  assert.equal(result.protectedCellCount, 0);
  assert.equal(Buffer.from(result.artifact.body, 'utf8').toString('utf8'), result.artifact.body);
});

test('CSV round trips through the existing spreadsheet import conventions', () => {
  const result = Actions.csvArtifact(exporting({source:'all'}), fixture());
  assert.deepEqual(Sheets.fromCsv(result.artifact.body, Papa), [['Notes','Account','Amount'], ['', 'Alpha','0'],
    ['saved value','Beta','25'], ['Visible first','Gamma','']]);
});

test('formula-like cells AND headers are neutralized, disclosed, and never mutate source text', () => {
  const dangerous = ['=1+1','+SUM(A1:A2)','-2+3','@SUM(1,2)','\tplain','\rplain','\nplain', '  =1',
    '\t\n=HYPERLINK("https://example.invalid","go")', '\u00a0+1', '\ufeff=1', '\u200b=1', '\u2066@SUM(1)',
    '\uff1d1+1','\uff0b1','\uff0d1','\uff201','-42', ' =cmd|\' /C test\'!A0', '\x01=1', '\x85=1'];
  const ordinary = ["'=1", 'text =1', 'a\n=1', '1,=2', '0', '   ', 'Name', '\u65e5\u672c\u8a9e', 0, -42, false, null];
  const context = fixture();
  context.columns = [{id:'account', name:'=unsafe header'}];
  context.records = [...dangerous, ...ordinary].map((account, index) => ({id:index + 1, account}));
  const before = structuredClone(context), result = Actions.plan(exporting({source:'all'}), context);
  assert.deepEqual(grid(result.artifact.body), [["'=unsafe header"], ...dangerous.map(value => ["'" + value]), ...ordinary.map(value => [String(value ?? '')])]);
  assert.equal(result.protectedCellCount, dangerous.length + 1);
  assert.match(result.disclosure, /apostrophe/);
  assert.match(result.disclosure, /re-import/);
  assert.match(result.disclosure, /Anyone with the file/);
  assert.deepEqual(context, before);
});

test('CSV never coerces objects/formulas/nonfinite values into misleading cells', () => {
  for (const value of [{formula:'1+1'}, [], NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 'x', new Date(), 'bad\0text']) {
    const context = fixture(); context.records[0].account = value;
    assert.throws(() => Actions.csvArtifact(exporting({source:'all'}, selected('account')), context), /literal text/);
  }
  const context = fixture(); context.records[0].hidden = {formula:'=1'};
  assert.doesNotThrow(() => Actions.csvArtifact(exporting({source:'all'}), context));
  const inherited = Object.create({account:'never read inherited cells'}); inherited.id = 11;
  context.records = [inherited];
  assert.deepEqual(grid(Actions.csvArtifact(exporting({source:'all'}, selected('account')), context).artifact.body), [['Account'],['']]);
});

test('columns must bind current IDs, not labels or stale definitions; duplicate labels remain positional', () => {
  assert.throws(() => Actions.csvArtifact(exporting({source:'all'}, selected('removed')), fixture()), code('view_columns_stale'));
  assert.throws(() => Actions.csvArtifact(exporting({source:'all'}, selected('Amount')), fixture()));
  for (const columns of [undefined, [], Array(1), [{id:'account'}], [{id:'account', name:'bad\0name'}],
    [{id:'account', name:'a'.repeat(301)}], [{id:'account',name:'A'},{id:'account',name:'B'}],
    [{id:'history',name:'History'}], [{id:'constructor',name:'Constructor'}]]) {
    assert.throws(() => Actions.csvArtifact(exporting({source:'all'}), {...fixture(), columns}));
  }
  const context = fixture(); context.columns = [{id:'account',name:''},{id:'value',name:''}];
  assert.deepEqual(grid(Actions.csvArtifact(exporting({source:'all'}), context).artifact.body)[0], ['', '']);
  context.columns = [{id:'account',name:'Same'},{id:'value',name:'Same'}];
  assert.deepEqual(grid(Actions.csvArtifact(exporting({source:'all'}), context).artifact.body)[1], ['Alpha','0']);
});

test('legacy and custom/dynamic current definitions fit the export contract', () => {
  const context = fixture(); context.columns = Core.definitions([{id:'cf_extra',name:'Extra',type:'text'}]);
  context.records[0].cf_extra = 'custom';
  const legacy = Actions.csvArtifact(exporting({source:'all'}, selected('cf_extra','value')), context);
  assert.deepEqual(grid(legacy.artifact.body)[1], ['custom','0']);
  context.columns = [{id:'f_new',name:'Updated label',type:'number',role:'none',options:[]}];
  context.records[0].f_new = 0;
  assert.deepEqual(grid(Actions.csvArtifact(exporting({source:'all'}), context).artifact.body)[1], ['0']);
  assert.throws(() => Actions.csvArtifact(exporting({source:'all'}, selected('cf_extra')), context), code('view_columns_stale'));
});

test('activity and health require actual context definitions; metadata remains forbidden even when listed', () => {
  const context = fixture(); context.records[0].activity = 'Called'; context.records[0].health = 'Healthy';
  for (const id of ['activity','health']) {
    assert.throws(() => Actions.csvArtifact(exporting({source:'all'}, selected(id)), context), code('view_columns_stale'));
  }
  context.columns.push({id:'activity',name:'Activity'}, {id:'health',name:'Health'});
  assert.deepEqual(grid(Actions.csvArtifact(exporting({source:'all'}, selected('health','activity')), context).artifact.body)[1], ['Healthy','Called']);
  assert.deepEqual(grid(Actions.csvArtifact(exporting({source:'all'}), context).artifact.body)[1].slice(-2), ['Called','Healthy']);
  for (const id of ['id','history','__proto__','prototype','constructor']) {
    const supplied = {...context, columns:[{id,name:'Not an exportable column'}]};
    assert.throws(() => Actions.csvArtifact(exporting({source:'all'}), supplied));
    assert.throws(() => Actions.csvArtifact(exporting({source:'all'}, selected(id)), supplied));
  }
});

test('safe CSV filenames cannot be paths, devices, alternate streams or header injection', () => {
  for (const name of ['CON','aux','COM1','LPT9','..','../../secret', 'C:\\Windows\\x:stream', 'x\r\nInjected: yes',
    'file.exe', 'report.csv', '\u202eexe.csv', '\u65e5\u672c\u8a9e', '\u00e9', 'x'.repeat(1000), '']) {
    const filename = Actions.safeFilename(name);
    assert.match(filename, /^pipechat-[a-zA-Z0-9_-]+\.csv$/);
    assert.ok(filename.length <= 93);
    assert.doesNotMatch(filename, /[\\/:\x00-\x1f]/);
  }
  assert.equal(Actions.safeFilename('..'), 'pipechat-records.csv');
  assert.equal(Actions.safeFilename('r\u00e9sum\u00e9'), 'pipechat-resume.csv');
  assert.throws(() => Actions.safeFilename({}));
  assert.equal(Actions.csvArtifact(exporting(savedByName()), fixture()).artifact.filename, 'pipechat-High-value.csv');
  assert.equal(Actions.csvArtifact(exporting(), fixture()).artifact.filename, 'pipechat-visible-records.csv');
});

test('all helpers work with deeply frozen input and returned data cannot mutate callers', () => {
  const context = freeze(fixture()), before = structuredClone(context);
  const saveAction = freeze(save()), openAction = freeze(open()), exportAction = freeze(exporting(savedById()));
  const saved = Actions.plan(saveAction, context, freeze({newViewId}));
  const opened = Actions.plan(openAction, context);
  const exported = Actions.plan(exportAction, context);
  const binding = Actions.revalidateSelection(freeze(opened.selection), context);
  Actions.verifyOpen(opened, context, freeze({applied:true, visibleIds:[22,11]}));
  saved.view.entityIds.reverse(); saved.commands[0].view.entityIds.push(ref(33));
  saved.selection.recordIds.reverse(); opened.tableView.filter.ids.reverse();
  exported.selection.recordIds.reverse(); exported.recordIds.reverse(); exported.columnIds.reverse(); binding.recordIds.reverse();
  assert.deepEqual(context, before);
  assert.deepEqual(exportAction, exporting(savedById()));
  assert.deepEqual(opened.selection.recordIds, [22,11]);
});

test('rejected operations leave every input unchanged and never emit a partial export', () => {
  const context = fixture(); context.views[0].entityIds.push(ref(999));
  const before = structuredClone(context); freeze(context);
  for (const action of [open(), save(savedById()), exporting(savedByName())]) {
    const input = freeze(action), previous = structuredClone(input);
    assert.throws(() => Actions.plan(input, context, {newViewId}));
    assert.deepEqual(input, previous); assert.deepEqual(context, before);
  }
});

test('browser UMD and CommonJS produce identical plans without network, DOM, clock or random IDs', () => {
  const browser = vm.createContext({});
  for (const file of ['business-workspace.js','vendor/papaparse.min.js','view-actions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), browser, {filename:file});
  }
  const api = browser.PipeChatViewActions, context = fixture();
  for (const action of [save(), open(), exporting(), exporting(savedByName(), selected('value','account'))]) {
    assert.deepEqual(JSON.parse(JSON.stringify(api.plan(action, context, {newViewId}))), Actions.plan(action, context, {newViewId}));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(api.actionSchemas())), Actions.actionSchemas());
  assert.equal(api.instructions, Actions.instructions);
  const prepared = api.plan(open(), context);
  assert.equal(api.verifyOpen(prepared, context, {applied:true, visibleIds:[22,11]}).visibleCount, 2);
  const unavailable = vm.createContext({PipeChatBusinessWorkspace:Business});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/view-actions.js'), 'utf8'), unavailable);
  assert.throws(() => unavailable.PipeChatViewActions.csvArtifact(exporting(), context), /Papa Parse/);
});
