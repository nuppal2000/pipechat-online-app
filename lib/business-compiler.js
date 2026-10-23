'use strict';
const {createHash}=require('node:crypto');
const Workspace=require('../public/business-workspace');
const Core=require('../public/pipeline-core');
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const literal=value=>({type:'string',enum:[value]}),string={type:'string'},nullable={type:['string','null']};
const values={type:'array',maxItems:40,items:object({field:string,value:{type:['string','number','boolean','null']}})};
const ref=object({source:{type:'string',enum:['alias','entity','primary']},key:string});
const norm=value=>String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
const maxReads=20,maxReadRecords=200,maxAnswerLength=30000;
const readId={type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'};
const identitySelectors=(maxIds=maxReadRecords)=>[
  {...object({kind:literal('ids'),ids:{type:'array',minItems:1,maxItems:maxIds,items:string}}),description:'Read exact saved record IDs from the authorized snapshot, never names or search text.'},
  {...object({kind:literal('field_equals'),field:string,value:{type:['string','number','boolean']}}),description:'Match a literal value in one exact schema field ID. Requires typeId. Use for name or email lookups; text equality ignores case and normalizes whitespace.'}
];
const readFields=()=>({typeId:nullable,selector:{anyOf:[
  {...object({kind:literal('all')}),description:'List all records in the chosen type and relationship scope.'},...identitySelectors(),
  {...object({kind:literal('text_search'),text:{type:'string',minLength:1,maxLength:12000}}),description:'Explicit broad substring search across stored values. Only literal search text, never a question, record ID, field name, or requested output.'},
  {...object({kind:literal('field_removal_check'),field:string}),description:'Read-only check of removal dependencies for one exact entity field ID. Requires typeId and a complete workspace snapshot; linkedTo and relationshipTypeId must be null. Never removes or clears data.'}
]},linkedTo:{anyOf:[{type:'null'},object({source:{type:'string',enum:['entity','primary']},key:string}),
  object({source:{type:'string',enum:['entity','primary']},typeId:string,selector:{anyOf:identitySelectors(1)}})]},relationshipTypeId:nullable});
const legacyReadKeys=['typeId','query','linkedTo','relationshipTypeId'];
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function schemas(){
  const field=object({id:string,name:string,type:{type:'string',enum:Workspace.fieldTypes},required:{type:'boolean'},options:{type:'array',items:string,maxItems:100}});
  const operations=[
    object({op:literal('put_type'),type:object({id:string,name:string,fields:{type:'array',minItems:1,maxItems:40,items:field}})}),
    object({op:literal('put_relationship_type'),type:object({id:string,name:string,fromType:string,toType:string,cardinality:{type:'string',enum:Workspace.cardinalities}})}),
    object({op:literal('upsert_entity'),alias:string,typeId:string,matchField:string,matchValue:string,mode:{type:'string',enum:['reuse','update']},values}),
    object({op:literal('update_entity'),id:string,values}),
    object({op:literal('delete_entity'),id:string}),
    object({op:literal('remove_field'),typeId:string,fieldId:string}),
    object({op:literal('merge_entities'),survivorId:string,sourceIds:{type:'array',minItems:1,maxItems:100,items:string},policy:{type:'string',enum:Workspace.mergePolicies},fieldResolutions:values}),
    object({op:literal('link'),typeId:string,from:ref,to:ref}),
    object({op:literal('unlink'),id:string})
  ];
  return [object({action:literal('business_plan'),version:{type:'integer',enum:[1]},title:string,operations:{type:'array',minItems:1,maxItems:200,items:{anyOf:operations}}}),
    object({action:literal('query_business'),...readFields()}),
    object({action:literal('query_business_batch'),queries:{type:'array',minItems:1,maxItems:maxReads,items:object({id:readId,...readFields()})}})];
}
function uuid(seed){const h=createHash('sha256').update(seed).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function cells(values){
  if(!Array.isArray(values)||values.length>40||values.some(v=>!v||typeof v.field!=='string')||new Set(values.map(v=>v.field)).size!==values.length)throw new Error('Supply each entity field once.');
  return Object.fromEntries(values.map(v=>[v.field,v.value]));
}
function entityName(entity,type){const field=type.fields.find(f=>f.required&&f.type==='text')||type.fields.find(f=>f.type==='text');return String(entity.values[field?.id]||entity.id);}
function query(snapshot,action){
  if(action?.action==='query_business_batch'){
    if(!exact(action,['action','queries'])||!Array.isArray(action.queries)||!action.queries.length||action.queries.length>maxReads)throw new Error(`Supply 1 to ${maxReads} independent entity reads.`);
    const ids=new Set();
    for(const item of action.queries){
      if(!(exact(item,['id',...Object.keys(readFields())])||exact(item,['id',...legacyReadKeys]))||typeof item.id!=='string'||!new RegExp(readId.pattern).test(item.id)||item.id==='root'||ids.has(item.id))throw new Error('Each entity read needs a unique ID and only typed query selectors.');
      ids.add(item.id);
    }
    // Every member reads the same authorized snapshot. No aliases, dependencies or writes.
    const results=action.queries.map((item,index)=>{
      try{return {id:item.id,...read(snapshot,item,maxReadRecords)};}
      catch(error){error.message=`Read ${index+1} (${item.id}): ${error.message}`;throw error;}
    });
    return {kind:'business-read-batch',mutates:false,results};
  }
  if(action?.action!=='query_business')throw new Error('Unsupported entity query.');
  const typed=Object.hasOwn(action,'selector'),keys=['action',...(typed?Object.keys(readFields()):legacyReadKeys)];
  if(typed?!exact(action,keys):Object.keys(action).some(key=>!keys.includes(key)))throw new Error('An entity read contains only typed query selectors.');
  return read(snapshot,action);
}
function readPredicate(action,type,candidates){
  // Old saved actions remain readable, but new model output has one explicit selector.
  if(!Object.hasOwn(action,'selector'))return entity=>!action.query||Object.values(entity.values).some(value=>norm(value).includes(norm(action.query)));
  const selector=action.selector;
  if(selector?.kind==='all'&&exact(selector,['kind']))return ()=>true;
  if(selector?.kind==='ids'&&exact(selector,['kind','ids'])){
    if(!Array.isArray(selector.ids)||!selector.ids.length||selector.ids.length>maxReadRecords||new Set(selector.ids).size!==selector.ids.length||
      selector.ids.some(id=>typeof id!=='string'||!candidates.some(entity=>entity.id===id)))throw new Error('Choose distinct saved record IDs available in this authorized entity type.');
    const ids=new Set(selector.ids);return entity=>ids.has(entity.id);
  }
  if(selector?.kind==='field_equals'&&exact(selector,['kind','field','value'])){
    const field=type?.fields.find(field=>field.id===selector.field),value=selector.value;
    if(!field)throw new Error('A field lookup requires an existing typeId and its exact field ID.');
    const valid=field.type==='number'?typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12:
      field.type==='boolean'?typeof value==='boolean':typeof value==='string'&&value.length<=12000&&!value.includes('\0')&&!!norm(value)&&
        (field.type!=='choice'||field.options.includes(value))&&
        (field.type!=='date'||/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='0100-01-01'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
    if(!valid)throw new Error('The lookup value must match the selected field type and cannot be blank.');
    return entity=>field.type==='text'?typeof entity.values[field.id]==='string'&&norm(entity.values[field.id])===norm(value):entity.values[field.id]===value;
  }
  if(selector?.kind==='text_search'&&exact(selector,['kind','text'])&&typeof selector.text==='string'&&selector.text.length<=12000&&norm(selector.text)&&!selector.text.includes('\0')){
    return entity=>Object.values(entity.values).some(value=>norm(value).includes(norm(selector.text)));
  }
  throw new Error('Choose a typed entity selector: all, ids, field_equals or text_search.');
}
function read(snapshot,action,limit=maxReadRecords){
  if(!snapshot?.state||!snapshot.primary)throw new Error('An authorized business snapshot is required.');
  if(action.typeId!==null&&(typeof action.typeId!=='string'||!action.typeId.trim()))throw new Error('Choose an existing entity type or null.');
  if(action.query!=null&&typeof action.query!=='string')throw new Error('An entity search must be text or null.');
  if(action.selector?.kind==='field_removal_check')return fieldRemovalRead(snapshot,action);
  const types=snapshot.state.entityTypes;
  if(action.typeId!==null&&action.typeId!=='primary'&&!types.some(t=>t.id===action.typeId))throw new Error('That entity type does not exist.');
  if(action.relationshipTypeId!=null&&!snapshot.state.relationshipTypes.some(t=>t.id===action.relationshipTypeId))throw new Error('That relationship type does not exist.');
  const core=Core.create(snapshot.primary.tableSchema),primary=snapshot.primary.records.map(row=>({id:row.entityId,typeId:'primary',values:row.values}));
  const primaryType={name:snapshot.primary.tableSchema?.title||'Pipeline',fields:core.definitions(snapshot.primary.customFields||[]).map(f=>({...f,required:f.id===core.role('primary')}))};
  const typeFor=id=>id==='primary'?primaryType:types.find(t=>t.id===id);
  let related=null,anchor=null,links=snapshot.state.relationships;
  if(action.linkedTo!=null){
    const typed=exact(action.linkedTo,['source','typeId','selector']);
    if(!typed&&!exact(action.linkedTo,['source','key']))throw new Error('Choose an existing entity or primary record for the relationship search.');
    const {source,key}=action.linkedTo;
    if(!['entity','primary'].includes(source)||!typed&&(typeof key!=='string'||!key.trim()))throw new Error('Choose an existing entity or primary record for the relationship search.');
    let candidates=source==='primary'?primary:snapshot.state.entities;
    if(typed){
      const {typeId,selector}=action.linkedTo;
      if(typeof typeId!=='string'||!typeFor(typeId)||(source==='primary')!==(typeId==='primary')||
        !['ids','field_equals'].includes(selector?.kind)||selector.kind==='ids'&&(!Array.isArray(selector.ids)||selector.ids.length!==1))throw new Error('A relationship anchor needs one saved ID or an exact field lookup in its existing type.');
      candidates=candidates.filter(row=>row.typeId===typeId);
      candidates=candidates.filter(readPredicate({selector},typeFor(typeId),candidates));
    }else candidates=candidates.filter(row=>row.id===key||source==='primary'&&norm(row.values[core.role('primary')])===norm(key));
    if(candidates.length!==1)throw new Error(candidates.length?'More than one linked record matches. Choose its stable ID.':'The linked record does not exist in the authorized snapshot; this is not a zero-link result.');
    anchor=candidates[0];
    links=links.filter(link=>(!action.relationshipTypeId||link.typeId===action.relationshipTypeId)&&(link.fromId===anchor.id||link.toId===anchor.id));
    related=new Set(links.map(link=>link.fromId===anchor.id?link.toId:link.fromId));
  }else if(action.relationshipTypeId!=null)throw new Error('A relationship type filter requires a linked record.');
  const candidates=(action.typeId==='primary'?primary:related?[...snapshot.state.entities,...primary]:snapshot.state.entities).filter(entity=>!action.typeId||entity.typeId===action.typeId);
  const predicate=readPredicate(action,action.typeId?typeFor(action.typeId):null,candidates);
  const rows=candidates.filter(entity=>(!related||related.has(entity.id))&&predicate(entity));
  const rowIds=new Set(rows.map(row=>row.id)),shown=rows.slice(0,limit),shownIds=new Set(shown.map(row=>row.id));
  const matches=link=>anchor?rowIds.has(link.fromId===anchor.id?link.toId:link.fromId):rowIds.has(link.fromId)||rowIds.has(link.toId);
  links=links.filter(matches);
  return {kind:'business-read',scope:{typeId:action.typeId,query:action.query??null,
    ...(Object.hasOwn(action,'selector')?{selector:structuredClone(action.selector)}:{}),
    linkedTo:anchor?{source:action.linkedTo.source,key:anchor.id}:null,relationshipTypeId:action.relationshipTypeId??null},
    records:shown.map(entity=>({id:entity.id,typeId:entity.typeId,name:entityName(entity,typeFor(entity.typeId)),values:structuredClone(entity.values)})),
    relationships:structuredClone(links.filter(link=>anchor?shownIds.has(link.fromId===anchor.id?link.toId:link.fromId):shownIds.has(link.fromId)||shownIds.has(link.toId))),
    count:rows.length,omittedCount:rows.length-shown.length,relationshipCount:links.length};
}
function fieldRemovalRead(snapshot,action){
  if(!exact(action.selector,['kind','field'])||typeof action.selector.field!=='string'||action.linkedTo!==null||action.relationshipTypeId!==null)throw new Error('A field removal check requires one exact field ID and no relationship filter.');
  // A projected share cannot prove that a field is unused across the workspace.
  if(snapshot.scope!=='workspace')throw new Error('Field removal dependencies require a complete authorized workspace snapshot, not a shared projection.');
  const preview=Workspace.fieldRemovalPreview(snapshot.state,{typeId:action.typeId,fieldId:action.selector.field});
  const stored=preview.dependencies.find(item=>item.kind==='stored_values'),ids=new Set(stored?.entityIds||[]);
  const type=snapshot.state.entityTypes.find(type=>type.id===action.typeId);
  return {kind:'business-read',mutates:false,
    scope:{typeId:action.typeId,query:null,selector:structuredClone(action.selector),linkedTo:null,relationshipTypeId:null},
    fieldRemoval:{typeId:preview.typeId,typeName:preview.typeName,fieldId:preview.field.id,fieldName:preview.field.name,
      removable:preview.removable,dependencies:preview.dependencies},
    records:snapshot.state.entities.filter(entity=>ids.has(entity.id)).map(entity=>({id:entity.id,typeId:entity.typeId,
      name:entityName(entity,type),values:{[preview.field.id]:entity.values[preview.field.id]}})),
    count:stored?.count||0,omittedCount:stored?.omittedCount||0,relationships:[],relationshipCount:0};
}
function describe(snapshot,result){
  if(result.kind==='business-read-batch'){
    const footer='Results are limited to the authorized snapshot. No changes were made.';
    const budget=Math.floor((maxAnswerLength-footer.length-result.results.length*2)/result.results.length);
    return [...result.results.map((item,index)=>boundedText(readLines(snapshot,item,`Read ${index+1} (${item.id})`),budget)),footer].join('\n\n');
  }
  return boundedText(readLines(snapshot,result),maxAnswerLength);
}
function* readLines(snapshot,result,heading){
  if(result.fieldRemoval){yield* fieldRemovalLines(result,heading);return;}
  const core=Core.create(snapshot.primary.tableSchema);
  const typeFor=id=>id==='primary'?{name:snapshot.primary.tableSchema?.title||'Pipeline',fields:core.definitions(snapshot.primary.customFields||[]).map(field=>({...field,required:field.id===core.role('primary')}))}:snapshot.state.entityTypes.find(t=>t.id===id);
  const label=value=>{const text=String(value).replace(/\s+/g,' ');return text.length>160?text.slice(0,160)+' [truncated]':text;};
  if(heading||result.scope?.selector){
    if(heading)yield heading;
    const scope=result.scope;
    yield `Record type: ${scope.typeId?label(typeFor(scope.typeId).name):scope.linkedTo?'All linked entity types and primary records':'All typed entities'}.`;
    if(scope.linkedTo){
      const anchor=scope.linkedTo.source==='primary'?snapshot.primary.records.find(row=>row.entityId===scope.linkedTo.key):snapshot.state.entities.find(row=>row.id===scope.linkedTo.key);
      const type=typeFor(scope.linkedTo.source==='primary'?'primary':anchor.typeId);
      yield `Linked to: ${label(entityName({...anchor,id:scope.linkedTo.key},type))} (${label(type.name)}; ${scope.linkedTo.key}).`;
      yield `Relationship: ${scope.relationshipTypeId?label(snapshot.state.relationshipTypes.find(type=>type.id===scope.relationshipTypeId).name):'Any stored relationship type'}.`;
    }
    if(scope.query)yield `Search text: ${JSON.stringify(label(scope.query))}.`;
    if(scope.selector?.kind==='ids')yield `Record IDs: ${scope.selector.ids.join(', ')}.`;
    if(scope.selector?.kind==='field_equals')yield `Field match: ${label(typeFor(scope.typeId).fields.find(field=>field.id===scope.selector.field).name)} (${scope.selector.field}) equals ${JSON.stringify(scope.selector.value)}.`;
    if(scope.selector?.kind==='text_search')yield `Search text: ${JSON.stringify(label(scope.selector.text))}.`;
    if(scope.typeId==='primary'||result.records.some(row=>row.typeId==='primary'))yield 'Primary results are existing pipeline rows; they do not establish separate typed company or deal entities.';
  }
  yield `${result.count} matching entities. Saved values:`;
  for(const row of result.records.slice(0,200)){
    const type=typeFor(row.typeId);
    yield `\n${row.name} (${type.name}${heading||result.scope?.selector?`; ${row.id}`:''})`;
    for(const field of type.fields)yield `${field.name}: ${row.values[field.id]??'Not set'}`;
  }
  if(result.count>200)yield 'Showing the first 200 entities. Narrow the search to see the remainder.';
  yield `${result.relationshipCount??result.relationships.length} stored relationships ${result.scope?.linkedTo?'match this relationship search':'involve these entities'}. No changes were made.`;
}
function* fieldRemovalLines(result,heading){
  const check=result.fieldRemoval;
  if(heading)yield heading;
  yield `Field removal check: ${JSON.stringify(check.fieldName)} on ${JSON.stringify(check.typeName)}.`;
  yield 'No field or saved value was removed. No changes were made.';
  if(check.removable){
    yield 'No stored-value or protected-field dependency blocks removal in this workspace snapshot. This read-only check is not a removal proposal. An owner must prepare and confirm removal, with dependencies checked again before saving.';
    return;
  }
  yield 'Removal is blocked:';
  for(const dependency of check.dependencies)yield '- '+dependency.message;
  if(result.count){
    yield `${result.count} records contain saved values; showing ${result.records.length}${result.omittedCount?`, ${result.omittedCount} omitted`:''}.`;
    for(const row of result.records)yield `- ${JSON.stringify(row.name)} (${row.id}): ${JSON.stringify(row.values[check.fieldId])}`;
    yield 'Keep this field to retain those values. The field-removal operation cannot delete a populated field or clear its values to bypass this guard.';
  }
}
function boundedText(lines,budget){
  const notice='\nAnswer details truncated. Narrow this read to see the remainder. No changes were made.';
  let text='';
  for(const line of lines){
    const next=text?(text.endsWith('\n')?'':'\n')+line:line;
    if(text.length+next.length+notice.length>budget)return text+notice;
    text+=next;
  }
  return text;
}
function prepare(snapshot,action,nonce){
  if(action.action!=='business_plan'||action.version!==1||!Array.isArray(action.operations)||!action.operations.length||action.operations.length>200)throw new Error('Invalid entity action plan.');
  if(action.operations.some(operation=>operation?.op==='remove_field')&&action.operations.length!==1)throw new Error('Review field removal separately from other changes.');
  const original=structuredClone(snapshot);let staged=structuredClone(snapshot);const commands=[],aliases=new Map(),review=[];
  const id=(prefix,index)=>prefix+uuid(`${snapshot.workspaceId}:${nonce}:${index}`);
  function resolve(reference){
    if(reference.source==='alias'){if(!aliases.has(reference.key))throw new Error('A relationship refers to an entity that has not been created or resolved.');return aliases.get(reference.key);}
    if(reference.source==='entity'){if(!staged.state.entities.some(e=>e.id===reference.key))throw new Error('That linked entity does not exist.');return reference.key;}
    if(reference.source==='primary'){
      const primary=Core.create(staged.primary.tableSchema).role('primary');
      const exact=staged.primary.records.filter(row=>row.entityId===reference.key||norm(row.values[primary])===norm(reference.key));
      if(exact.length!==1)throw new Error(exact.length?'More than one primary record matches. Specify its ID.':'That primary record does not exist.');
      return exact[0].entityId;
    }
    throw new Error('Invalid relationship reference.');
  }
  for(const [index,operation] of action.operations.entries()){
    let command;
    if(['put_type','put_relationship_type'].includes(operation.op))command=operation;
    else if(operation.op==='upsert_entity'){
      if(!operation.alias||aliases.has(operation.alias))throw new Error('Use a distinct alias for each entity.');
      if(!['reuse','update'].includes(operation.mode))throw new Error('Choose whether to reuse or update the matched entity.');
      const type=staged.state.entityTypes.find(t=>t.id===operation.typeId);
      if(!type||!type.fields.some(f=>f.id===operation.matchField))throw new Error('Choose an existing entity type and identity field.');
      if(!norm(operation.matchValue))throw new Error('An entity identity cannot be blank.');
      const matches=staged.state.entities.filter(e=>e.typeId===type.id&&norm(e.values[operation.matchField])===norm(operation.matchValue));
      if(matches.length>1)throw new Error('More than one entity matches. Choose its stable ID before updating or linking.');
      const values=cells(operation.values);
      if(values[operation.matchField]!==undefined&&norm(values[operation.matchField])!==norm(operation.matchValue))throw new Error('The supplied identity and entity name disagree.');
      if(matches.length){
        aliases.set(operation.alias,matches[0].id);
        if(operation.mode==='reuse'){
          const discarded=Object.entries(values).filter(([field,value])=>field!==operation.matchField&&value!==null&&value!==''&&value!==matches[0].values[field]);
          if(discarded.length)throw new Error('Reusing this existing entity would discard supplied values. Include an explicit update with those values in the same review, or omit them when retaining the existing values.');
          review.push({operation:'reuse_entity',id:matches[0].id,name:entityName(matches[0],type)});continue;
        }
        command={op:'update_entity',id:matches[0].id,values};
      }else{
        const entity={id:id('ent_',index),typeId:type.id,values:{...values,[operation.matchField]:operation.matchValue}};
        aliases.set(operation.alias,entity.id);command={op:'create_entity',entity};
      }
    }else if(operation.op==='update_entity')command={op:operation.op,id:operation.id,values:cells(operation.values)};
    else if(operation.op==='remove_field')command={op:operation.op,typeId:operation.typeId,fieldId:operation.fieldId};
    else if(['delete_entity','unlink'].includes(operation.op))command={op:operation.op,id:operation.id};
    else if(operation.op==='merge_entities'){
      const preview=Workspace.mergePreview(staged.state,operation);
      command={op:'merge_entities',survivorId:operation.survivorId,sourceIds:operation.sourceIds,policy:preview.policy,fieldResolutions:cells(operation.fieldResolutions),replacementLinkIds:Object.fromEntries(preview.redirectedLinkIds.map(oldId=>[oldId,'lnk_'+uuid(`${snapshot.workspaceId}:${nonce}:${index}:${oldId}`)]))};
    }
    else if(operation.op==='link'){
      const fromId=resolve(operation.from),toId=resolve(operation.to);
      const existing=staged.state.relationships.find(r=>r.typeId===operation.typeId&&r.fromId===fromId&&r.toId===toId);
      if(existing){review.push({operation:'reuse_link',id:existing.id});continue;}
      command={op:'link',relationship:{id:id('lnk_',index),typeId:operation.typeId,fromId,toId}};
    }else throw new Error('Unsupported entity operation. No partial changes were prepared.');
    const before=command.op==='remove_field'?Workspace.fieldRemovalPreview(staged.state,command):command.op==='merge_entities'?{entities:staged.state.entities.filter(e=>e.id===command.survivorId||command.sourceIds.includes(e.id)),...Workspace.mergePreview(staged.state,command)}:command.op==='update_entity'||command.op==='delete_entity'?staged.state.entities.find(e=>e.id===command.id):null;
    let result;
    try{result=Workspace.prepare(staged,[command]);}
    catch(error){error.message=`Operation ${index+1} (${operation.op}): ${error.message}`;throw error;}
    staged={...staged,state:result.next};commands.push(command);review.push({...command,...(before?{before:structuredClone(before)}:{})});
  }
  const result=commands.length?Workspace.prepare(original,commands):{workspaceId:snapshot.workspaceId,expectedVersion:snapshot.version,expectedPrimaryUpdatedAt:snapshot.primary.updatedAt,next:snapshot.state,changes:[]};
  return {...result,kind:'business-plan',title:action.title,commands,review,mutates:commands.length>0};
}
const instructions=[
  'First-class records and relationships use business_plan, not extra text columns. pipeline.business contains the authorized entity schema, stable IDs, entities, relationships and read-through primary records. Keep the existing pipeline untouched when creating additional types.',
  'For a business workflow description requiring several record types, propose all types and relationship types together. Use concise important fields (text/number/boolean/date/choice), with a required identity text field. IDs are stable lowercase identifiers. primary is the existing pipeline type. Do not duplicate the pipeline as another type unless requested.',
  'For an explicit request to create a typed record, ordinary schema naming is a proposal default, not a missing business fact. Reuse the unique existing type that fits the requested meaning, with its exact type/field IDs and full schema. If none fits, use the user\'s noun as the new type label (for example Contact), a fresh lowercase ID, and a required Name text field with options []. Do not ask Contact versus Client Contact when neither exists and either is only a possible new label. Unrelated empty recruiting types are not substitutes for a contact type. If multiple existing types genuinely fit, clarify the business distinction. Do not replace or rename an existing type merely to use a preferred label; omit unknown optional facts and never invent required facts.',
  'For a NEW ordinary association without a stated exclusivity rule, propose cardinality many_to_many. Do not ask the user a technical one/many cardinality question just to link named records. This is only a default for a new relationship type: reuse an existing compatible relationship and preserve its exact fromType, toType and cardinality. Never widen an existing contract, add a parallel relationship to evade its limits, or infer exclusivity from a single requested link. If a real existing limit prevents the link, explain that business conflict and ask which intended association should be kept.',
  'Use upsert_entity to create or reuse contacts/companies by a normalized exact identity field in the chosen type. mode reuse keeps all existing values; mode update proposes only supplied values. A primary-row contact text cell is not a saved typed contact entity. No fuzzy guess: if multiple entities match ask which. Bind later links via source alias and the preceding alias; reference existing primary records with source primary and their exact entityId. Relationship queries traverse both directions, but link writes MUST follow the declared fromType/toType direction: reverse the references if the existing definition runs from primary to contact. Do not emit a second reverse link just to make the relationship bidirectional.',
  'Inspect pipeline.business.primary.records separately from pipeline.business.state.entities. A saved primary account/deal row is one existing record, not proof of a separate typed Company entity; an empty Company type contains no saved company records. When company and deal refer to that one combined primary row, propose one contact-to-primary association and explicitly explain that representation. Do not claim it creates two distinct company/deal links. If the user requires separate company and deal records but only the primary row exists, retain both requested outcomes and ask one concrete business question about creating the missing company or using only the existing primary row. Do not silently create the missing company, duplicate the primary deal, omit a required link, or ask naming/cardinality questions instead.',
  'Compile in dependency order: put_type for each genuinely new type, then put_relationship_type using existing or earlier-created type IDs, then upsert_entity, then link using resolved aliases or saved IDs. Every operation is validated against the state built so far. primary is a reserved read-through type, never a put_type or upsert_entity target. References with source entity need exact saved ent_ IDs, not display names or primary IDs. New entity/link UUIDs are allocated by the compiler; do not invent them. A supplied request to reuse an existing contact uses mode reuse; retain its current unsupplied values and reuse an existing identical link.',
  'Preview before saving already authorizes preparing the requested records and links, not executing them. Include any necessary new schema in the same business_plan proposal and state which records/links are new versus reused. Do not ask for another permission to prepare this preview. Missing real targets, required business values, ambiguous saved identities, and permissions still require resolution; technical default choices alone do not.',
  'Use query_business for entity reads, update_entity with exact existing IDs for changes, delete_entity for explicit removal and unlink then link for reassociation. Every operation is one staged all-or-nothing entity plan. Do not change permission grants, memberships or real recipients through AI. Use the explicit Shared views controls for sharing.',
  'For explicit removal of an unused optional field from a typed entity, use a business_plan containing only remove_field with the exact saved typeId and fieldId. Never substitute primary-table delete_field or put_type with an omitted field. The application checks stored-value dependencies and protects required and identifying fields; primary-table fields use their separate family. A populated field must not be cleared, dropped or recreated to evade this guard. Explain the dependency if removal is blocked. Successful removal preserves every entity, unrelated field, relationship, shared view and primary record. Prepare the removal for confirmation; do not ask permission to prepare it or claim it is already saved.',
  'A blocked entity-field removal has a canonical read-only explanation: use query_business with the exact typeId, selector {kind:"field_removal_check",field:exact field ID}, linkedTo null and relationshipTypeId null. Use it when the user asks to inspect removal dependencies or to leave a field unchanged and explain if removal is unsafe; if remove_field preparation reports dependencies, repair with this read instead of repeating the rejected mutation or returning unsupported prose. It computes protected-field blockers and saved-value counts from the whole authorized workspace, with bounded supporting records. Ordinary name/email selectors cannot establish whether a field is removable. Never filter the check to blank records, use a partial shared projection to claim a field is unused, or clear values to make removal pass.',
  'For review of a conditional or blocked removal, computed.fieldRemoval.removable false and its dependencies are computed_read evidence for the safe no-change explanation, not a failed mutation or missing user input. Map this outcome to root (or the specific batch query ID), with requiredOutputs fields for the dependency facts; add count/names only when requested. The canonical answer states that nothing was removed. Do not demand a destructive proposal to satisfy a condition whose stored-data blocker is proven. This exception is limited to that blocked removal: preserve other independent outcomes. When removable is true, a check alone does NOT satisfy a request to remove the field; compile the explicit remove_field proposal for confirmation. A request only to inspect dependencies never authorizes that mutation.',
  'Entity reads use selector, not a free-form query. Choose {kind:"all"} to list a type; {kind:"ids",ids:[exact saved ID]} for a uniquely identified saved entity; {kind:"field_equals",field:exact field ID,value:literal value} for a named person or email lookup; or {kind:"text_search",text:literal fragment} only for an explicitly broad text search. A field_equals selector requires the exact typeId. Resolve type and field IDs from the CURRENT authorized entity schema, including renamed labels and generated IDs; never assume they are contact, name or email. Text equality normalizes case and whitespace, not punctuation or partial names. Numeric and Boolean values retain their types. Never put a whole question, possessive wording, requested field label or record ID into search text. The requested output (such as an email address) is not part of the name selector: canonical reads return the matching records\' saved fields. If a singular reference matches multiple entities, clarify using their saved IDs rather than choose the first. Missing or inaccessible IDs must not fall back to a name search. A zero count proves only the explicit selector and relationship scope, not the absence of every Contact.',
  'For relationship questions use query_business.linkedTo with {source:"entity",key:exact saved entity ID}, {source:"primary",key:exact primary ID}, or {source:"entity"|"primary",typeId:exact anchor type ID,selector:{kind:"field_equals",field:exact anchor field ID,value:literal name or email}}. A typed anchor can also use selector ids with exactly one saved ID. A unique exact saved name already resolves identity; do not ask the user to confirm that intended Contact. Only multiple matches need an identity clarification. The join traverses both directions and returns only genuinely linked saved records. Use result typeId primary and selector all to list pipeline records linked to a contact, or the contact entity type to list contacts linked to a primary record. Choose an existing relationshipTypeId for the requested association when applicable. A missing or ambiguous anchor is an error, not zero relationships; a successfully resolved anchor with no matching saved links has a canonical zero result. Use null linkedTo and relationshipTypeId for an ordinary entity search.',
  'For multiple independent saved-entity questions use query_business_batch with 1 to 20 queries. Each query has a unique lowercase id (not root), typeId, selector, linkedTo and relationshipTypeId, using the same selectors as query_business. Include one query per distinct requested scope or target type; never replace several independent scopes with a union or answer a missing scope from raw snapshot prose. All members read the same authorized saved snapshot, not another member\'s results or a proposed mutation. No operations, aliases, writes, aggregates or primary-table changes belong in this read-only family. The application computes an ordered result for every query, including zero matches, and renders canonical answers; query IDs and planner commentary are not evidence.',
  'For a compound relationship read, preserve both directions as separate query members with exact saved endpoints. A linked primary row remains one combined record, not proof of separate typed company and deal entities. Query a separate typed company only if that type actually exists; report zero saved links when it is empty. Do not invent a company, infer a relationship from a text cell, or claim two distinct links to a single primary row. Review each requested read against its own computed results entry and scope, not another member\'s records or incidental relationships.',
  'For an explicitly requested duplicate-entity merge use merge_entities with exact survivorId/sourceIds of the same type. policy explicit needs fieldResolutions [{field,value}] only for conflicting nonblank values. A blank survivor field with one distinct nonblank source value is filled automatically and is NOT a conflict. When the user chooses to retain the survivor values and fill only blanks, set policy keep_survivor_fill_blanks and fieldResolutions [] unless a blank survivor field has several distinct source values. This policy also retains the survivor Name, zero and false values; never ask again whether a uniquely available source value should fill a blank. Clarify only genuinely competing source values for a blank, an ambiguous identity or a relationship-cardinality conflict. On a clarification reply continue pendingClarification.originalCommand and its existing survivor/source IDs with the selected policy; it is a merge proposal, not a separate field update or permission-to-preview question. Choose only stored values. Links are redirected and deduplicated. The survivor keeps its identity. Source-only sharing grants and view memberships are removed, never silently transferred to a broader survivor; disclose this in the review. Pipeline-row merging is handled by the separate import review.',
  'Do not claim an entity is saved or linked before confirmation. A company, contact or job entity is distinct from a similarly named text field. Do not silently discard requested relationships or unrelated pipeline records.'
].join('\n');
module.exports={schemas,prepare,query,describe,instructions};
