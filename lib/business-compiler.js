'use strict';
const {createHash}=require('node:crypto');
const Workspace=require('../public/business-workspace');
const Core=require('../public/pipeline-core');
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const literal=value=>({type:'string',enum:[value]}),string={type:'string'},nullable={type:['string','null']};
const values={type:'array',maxItems:40,items:object({field:string,value:{type:['string','number','boolean','null']}})};
const ref=object({source:{type:'string',enum:['alias','entity','primary']},key:string});
const norm=value=>String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
function schemas(){
  const field=object({id:string,name:string,type:{type:'string',enum:Workspace.fieldTypes},required:{type:'boolean'},options:{type:'array',items:string,maxItems:100}});
  const operations=[
    object({op:literal('put_type'),type:object({id:string,name:string,fields:{type:'array',minItems:1,maxItems:40,items:field}})}),
    object({op:literal('put_relationship_type'),type:object({id:string,name:string,fromType:string,toType:string,cardinality:{type:'string',enum:Workspace.cardinalities}})}),
    object({op:literal('upsert_entity'),alias:string,typeId:string,matchField:string,matchValue:string,mode:{type:'string',enum:['reuse','update']},values}),
    object({op:literal('update_entity'),id:string,values}),
    object({op:literal('delete_entity'),id:string}),
    object({op:literal('merge_entities'),survivorId:string,sourceIds:{type:'array',minItems:1,maxItems:100,items:string},fieldResolutions:values}),
    object({op:literal('link'),typeId:string,from:ref,to:ref}),
    object({op:literal('unlink'),id:string})
  ];
  return [object({action:literal('business_plan'),version:{type:'integer',enum:[1]},title:string,operations:{type:'array',minItems:1,maxItems:200,items:{anyOf:operations}}}),
    object({action:literal('query_business'),typeId:nullable,query:nullable,linkedTo:{anyOf:[{type:'null'},object({source:{type:'string',enum:['entity','primary']},key:string})]},relationshipTypeId:nullable})];
}
function uuid(seed){const h=createHash('sha256').update(seed).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function cells(values){
  if(!Array.isArray(values)||values.length>40||values.some(v=>!v||typeof v.field!=='string')||new Set(values.map(v=>v.field)).size!==values.length)throw new Error('Supply each entity field once.');
  return Object.fromEntries(values.map(v=>[v.field,v.value]));
}
function entityName(entity,type){const field=type.fields.find(f=>f.required&&f.type==='text')||type.fields.find(f=>f.type==='text');return String(entity.values[field?.id]||entity.id);}
function query(snapshot,action){
  if(action.action!=='query_business')throw new Error('Unsupported entity query.');
  const types=snapshot.state.entityTypes;
  if(action.typeId!==null&&action.typeId!=='primary'&&!types.some(t=>t.id===action.typeId))throw new Error('That entity type does not exist.');
  if(action.relationshipTypeId!=null&&!snapshot.state.relationshipTypes.some(t=>t.id===action.relationshipTypeId))throw new Error('That relationship type does not exist.');
  const core=Core.create(snapshot.primary.tableSchema),primary=snapshot.primary.records.map(row=>({id:row.entityId,typeId:'primary',values:row.values}));
  const primaryType={name:snapshot.primary.tableSchema?.title||'Pipeline',fields:core.definitions(snapshot.primary.customFields||[]).map(f=>({...f,required:f.id===core.role('primary')}))};
  const typeFor=id=>id==='primary'?primaryType:types.find(t=>t.id===id);
  let related=null;
  if(action.linkedTo){
    const {source,key}=action.linkedTo;
    if(!['entity','primary'].includes(source)||typeof key!=='string'||!key.trim())throw new Error('Choose an existing entity or primary record for the relationship search.');
    const candidates=(source==='primary'?primary:snapshot.state.entities).filter(row=>row.id===key||source==='primary'&&norm(row.values[core.role('primary')])===norm(key));
    if(candidates.length!==1)throw new Error(candidates.length?'More than one linked record matches. Choose its stable ID.':'The linked record does not exist.');
    related=new Set(snapshot.state.relationships.filter(link=>(!action.relationshipTypeId||link.typeId===action.relationshipTypeId)&&(link.fromId===candidates[0].id||link.toId===candidates[0].id)).map(link=>link.fromId===candidates[0].id?link.toId:link.fromId));
  }
  const candidates=action.typeId==='primary'?primary:related?[...snapshot.state.entities,...primary]:snapshot.state.entities;
  const rows=candidates.filter(e=>(!action.typeId||e.typeId===action.typeId)&&(!related||related.has(e.id))&&(!action.query||Object.values(e.values).some(v=>norm(v).includes(norm(action.query)))));
  return {kind:'business-read',records:rows.map(entity=>({id:entity.id,typeId:entity.typeId,name:entityName(entity,typeFor(entity.typeId)),values:entity.values})),
    relationships:snapshot.state.relationships.filter(r=>rows.some(e=>e.id===r.fromId||e.id===r.toId)),count:rows.length};
}
function describe(snapshot,result){
  const lines=[`${result.count} matching entities. Saved values:`];
  for(const row of result.records.slice(0,200)){
    const type=row.typeId==='primary'?{name:snapshot.primary.tableSchema?.title||'Pipeline',fields:Core.create(snapshot.primary.tableSchema).definitions(snapshot.primary.customFields||[])}:snapshot.state.entityTypes.find(t=>t.id===row.typeId);
    lines.push(`${row.name} (${type.name})\n`+type.fields.map(f=>`${f.name}: ${row.values[f.id]??'Not set'}`).join('\n'));
  }
  if(result.count>200)lines.push('Showing the first 200 entities. Narrow the search to see the remainder.');
  lines.push(`${result.relationships.length} stored relationships involve these entities. No changes were made.`);
  return lines.join('\n\n');
}
function prepare(snapshot,action,nonce){
  if(action.action!=='business_plan'||action.version!==1||!Array.isArray(action.operations)||!action.operations.length||action.operations.length>200)throw new Error('Invalid entity action plan.');
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
    else if(['delete_entity','unlink'].includes(operation.op))command={op:operation.op,id:operation.id};
    else if(operation.op==='merge_entities'){
      const preview=Workspace.mergePreview(staged.state,operation);
      command={op:'merge_entities',survivorId:operation.survivorId,sourceIds:operation.sourceIds,fieldResolutions:cells(operation.fieldResolutions),replacementLinkIds:Object.fromEntries(preview.redirectedLinkIds.map(oldId=>[oldId,'lnk_'+uuid(`${snapshot.workspaceId}:${nonce}:${index}:${oldId}`)]))};
    }
    else if(operation.op==='link'){
      const fromId=resolve(operation.from),toId=resolve(operation.to);
      const existing=staged.state.relationships.find(r=>r.typeId===operation.typeId&&r.fromId===fromId&&r.toId===toId);
      if(existing){review.push({operation:'reuse_link',id:existing.id});continue;}
      command={op:'link',relationship:{id:id('lnk_',index),typeId:operation.typeId,fromId,toId}};
    }else throw new Error('Unsupported entity operation. No partial changes were prepared.');
    const before=command.op==='merge_entities'?{entities:staged.state.entities.filter(e=>e.id===command.survivorId||command.sourceIds.includes(e.id)),...Workspace.mergePreview(staged.state,command)}:command.op==='update_entity'||command.op==='delete_entity'?staged.state.entities.find(e=>e.id===command.id):null;
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
  'For relationship questions use query_business.linkedTo with the exact entity ID or primary record name/ID and an optional relationshipTypeId. The join traverses both directions and returns only genuinely linked saved records. Use typeId primary to list pipeline records linked to a contact, or the contact entity type to list contacts linked to a primary record. Use null linkedTo and relationshipTypeId for an ordinary entity search.',
  'For an explicitly requested duplicate-entity merge use merge_entities, exact survivorId/sourceIds of the same type and fieldResolutions [{field,value}] for every conflicting nonblank value. Choose only stored values according to the user choice; clarify unresolved conflicts rather than discard them. Links are redirected and deduplicated. The survivor keeps its identity. Source-only sharing grants and view memberships are removed, never silently transferred to a broader survivor; disclose this in the review. Pipeline-row merging is handled by the separate import review.',
  'Do not claim an entity is saved or linked before confirmation. A company, contact or job entity is distinct from a similarly named text field. Do not silently discard requested relationships or unrelated pipeline records.'
].join('\n');
module.exports={schemas,prepare,query,describe,instructions};
