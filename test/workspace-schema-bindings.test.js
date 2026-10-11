'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const branch=(schema,op)=>schema.properties.steps.items.anyOf.find(item=>item.properties.op.enum.includes(op)).properties;

test('workspace schema binds all CRM field references to stable saved IDs or dependent new fields',()=>{
  const core=Core.create(F.schema),custom=[{id:'cf_notes',name:'Extra notes',type:'text',options:[]}];
  const schema=Plan.responseSchema(core,custom),ids=core.definitions(custom).map(f=>f.id);
  const selection=branch(schema,'select_records');
  for(const ref of [selection.where.items.items.properties.field,selection.orderBy,
    branch(schema,'update_records').assignments.items.properties.field,branch(schema,'rename_choice_option').field]){
    assert.deepEqual(ref.anyOf[0].enum,ids);
    assert.equal(ref.anyOf[1].pattern,'^@[a-z][a-z0-9_]{0,39}$');
    assert(new RegExp(ref.anyOf[1].pattern).test('@risk'));
    assert(!new RegExp(ref.anyOf[1].pattern).test('Deal Value'));
  }
  assert.deepEqual(selection.orderBy.anyOf.at(-1),{type:'null'});
});

test('read output types require numeric IDs for arithmetic and null for record counts/names',()=>{
  for(const tableSchema of [F.schema,{...F.schema,fields:F.schema.fields.filter(f=>!['number','currency'].includes(f.type))}]){
    const core=Core.create(tableSchema),outputs=branch(Plan.responseSchema(core),'read_records').outputs.items.anyOf;
    assert.deepEqual(outputs[0].properties.field,{type:'null'});
    assert.deepEqual(outputs[0].properties.kind.enum,['count','names']);
    const numeric=core.definitions([]).filter(f=>['number','currency'].includes(f.type)).map(f=>f.id);
    const arithmetic=outputs.find(item=>item.properties.kind.enum.includes('average'));
    if(numeric.length)assert.deepEqual(arithmetic.properties.field.enum,numeric);
    else assert.equal(arithmetic,undefined);
  }
});
