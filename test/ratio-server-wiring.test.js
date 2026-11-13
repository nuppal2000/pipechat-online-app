'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const Ratio=require('../lib/ratio-calculation-intent'),Review=require('../lib/action-review');
const F=require('./fixtures/workspace-plans.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
const plannerFormat='pipechat_response',ratioFormat='pipechat_ratio_calculation_intent',reviewFormat='pipechat_action_review';
const cohort=[[F.where('f_deal','starts_with','QA1110')]],won=[[F.where('f_stage','equals','Closed Won')]];
const commands=[
  'Show the percentage of QA1110 deals that are Won, next to the percentage of their known value that is Won.',
  'For QA1110 deals, give me two percentages: the share of deals that are Won, and the share of known Deal Value that is Won. Show the numerator and denominator for each.'
];
function fixture(partial=false,userCommand=commands[0]){
  const p={...F.workspace(),currentDate:'2026-11-13',workspaceVersion:'ratio-server-current',visibleIds:[1,2]};
  p.tableSchema.fields.find(field=>field.id==='f_value').name='Deal Value';
  const template=p.records[0];
  p.records=[15000,18000,22000,8500,2000,0,null].map((f_value,index)=>({...copy(template),id:index+1,
    f_deal:'QA1110 Deal '+(index+1),f_stage:index?'Qualified':'Closed Won',f_value}));
  p.records.push({...copy(template),id:8,f_deal:'PRIVATE_UNRELATED_RECORD',f_value:999999,f_stage:'Closed Won'});
  p.dashboard={board:{version:1,elements:[],sharedFilters:[],activeId:null}};
  const intent={completeIntent:!partial,otherRequestedWork:partial,ambiguity:false,
    ratios:[['count',null],['sum','f_value']].map(([metric,field])=>({
      label:metric==='count'?'Won deal share':'Won known value share',population:{source:'all',where:copy(cohort)},
      numerator:{metric,field,where:copy(won)},denominator:{metric,field,where:[]}
    }))};
  return {intent,payload:{pipeline:p,userCommand:partial?
    'For QA1110 deals, calculate the Won share of deals and the Won share of known Deal Value. Also show their numerators and denominators in two separate temporary dashboard KPI panels.':userCommand}};
}
function dashboard(intent,wrong=false){
  return {action:'dashboard_plan',requestScope:null,
    operations:intent.ratios.map((ratio,index)=>({op:'add',id:'share_'+index,spec:{
      version:1,title:ratio.label,chart:'kpi',scope:'all',groupBy:null,splitBy:null,bucket:'none',sort:'label_asc',limit:null,
      where:wrong&&index?[[...copy(cohort[0]),F.where('f_value','is_not_blank')]]:copy(cohort),
      measures:wrong?[{label:ratio.label,metric:'percentage',field:null,where:copy(won)}]:
        [{label:'Numerator',...copy(ratio.numerator)},{label:'Denominator',...copy(ratio.denominator)}]
    }})),
    questions:wrong?[]:intent.ratios.map((ratio,index)=>({kind:'percentage',label:ratio.label,
      left:{elementId:'share_'+index,measure:0,stat:'aggregate'},right:{elementId:'share_'+index,measure:1,stat:'aggregate'}}))};
}
const proposal=action=>({crmAction:action,assistantMessage:'PRIVATE_PLANNER_PROSE: known-value share is 16.67%.',memoryNote:null});
function displayReview(action,satisfied=true){
  const requirement=(description,stepIds,requiredOutputs)=>({description,evidenceKind:'computed_read',stepIds,requiredOutputs,satisfied:true});
  return {requirements:[
    requirement('Won share of all QA1110 deals with both operands',['percentage:0'],['percentages','numerator','denominator','count']),
    requirement('Won share of known QA1110 Deal Value with both operands',['percentage:1'],['percentages','numerator','denominator','sum']),
    {...requirement('Show both requested temporary operand panels',['graph:share_0','graph:share_1'],['separate_widgets']),satisfied}
  ],issues:satisfied?[]:['The requested display obligation is not satisfied.'],clarificationQuestion:null,
  answerIntent:'canonical',answerSelection:null,presentationIntent:{status:'resolved',elements:action.operations.map(({spec})=>({
    chart:spec.chart,groupBy:spec.groupBy,splitBy:spec.splitBy,bucket:spec.bucket,measures:spec.measures.map(({metric,field})=>({metric,field}))
  }))}};
}

// Compile the real server in the validators' realm, omitting startup and
// replacing only HTTP/provider I/O. Spies below delegate to real proof functions.
function harness(planner,intentReviewer,reviewer=()=>assert.fail('Unexpected general review')){
  const filename=path.join(__dirname,'../server.js'),source=fs.readFileSync(filename,'utf8'),localRequire=createRequire(filename);
  const startup=source.lastIndexOf('start().catch(');assert(startup>0);
  const calls=[],logs=[],failures=[],evidence=[],assessments=[],preparations=[],renders=[],validations=[],events=[],normalizations=[],otherChecks=[];
  const requireOffline=name=>{
    if(name==='node:http')return {createServer:()=>({})};
    if(name==='./lib/action-review.js')return {...Review,
      evidence:(payload,result)=>{
        events.push('evidence');
        const computed=Review.evidence(payload,result);evidence.push({payload,action:result.crmAction,computed});return computed;
      },
      validateReview:(review,result,context)=>{
        const checked=Review.validateReview(review,result,context);validations.push({review,action:result.crmAction,context,checked});return checked;
      },
      renderAnswer:(payload,result,computed)=>{
        renders.push({payload,action:result.crmAction,computed});return Review.renderAnswer(payload,result,computed);
      }
    };
    if(name==='./lib/ratio-calculation-intent.js')return {...Ratio,
      normalizeAction:(action,pipeline)=>{
        events.push('normalize');const normalized=Ratio.normalizeAction(action,pipeline);
        normalizations.push({action,normalized,pipeline});return normalized;
      },
      prepare:(intent,pipeline)=>{
        events.push('prepare');
        const prepared=Ratio.prepare(intent,pipeline);preparations.push({intent,pipeline,prepared});return prepared;
      },
      assess:(intent,action,context)=>{
        events.push('assess');
        const checked=Ratio.assess(intent,action,context);assessments.push({intent,action,context,checked});return checked;
      }
    };
    if(['./lib/conditional-classification-intent.js','./lib/derived-calculation-intent.js','./lib/task-query-intent.js',
      './lib/named-numeric-intent.js','./lib/date-shift-intent.js'].includes(name)){
      const checker=localRequire(name),wrapped={...checker};
      for(const method of ['eligible','candidateEligible','input','assess'])if(typeof checker[method]==='function')wrapped[method]=(...args)=>{
        otherChecks.push({name,method});return checker[method](...args);
      };
      return wrapped;
    }
    return localRequire(name);
  };
  const fetchOffline=async(url,options)=>{
    try{
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body=JSON.parse(options.body),input=JSON.parse(typeof body.input==='string'?body.input:body.input[0].content[0].text);
      const name=body.text.format.name;calls.push({name,body,input});events.push(name);
      assert([plannerFormat,ratioFormat,reviewFormat].includes(name),'Unexpected model call: '+name);
      const result=await (name===plannerFormat?planner:name===ratioFormat?intentReviewer:reviewer)(input,body);
      return {ok:true,json:async()=>({output_text:JSON.stringify(result)})};
    }catch(error){failures.push(error);throw error;}
  };
  const load=vm.compileFunction(source.slice(0,startup)+'\nreturn planPipeChatAction;',
    ['require','process','fetch','__dirname','console'],{filename});
  const plan=load(requireOffline,{env:{PIPECHAT_STORAGE_PROVIDER:'json',OPENAI_API_KEY:'OFFLINE_FIXTURE_ONLY',NODE_ENV:'test'}},
    fetchOffline,path.dirname(filename),{log:line=>logs.push(JSON.parse(line)),warn:line=>logs.push(JSON.parse(line))});
  return {calls,logs,evidence,assessments,preparations,renders,validations,events,normalizations,otherChecks,plan:async(payload,startedAt=Date.now())=>{
    try{return await plan(payload,{tier:'complex',model:'gpt-5.2',reason:'offline_test'},startedAt);}
    finally{if(failures.length)throw failures[0];}
  }};
}

test('server locally repairs count-based value percentages into a freshly proved answer-only count/sum plan',async()=>{
  for(const command of commands){
    const {payload,intent}=fixture(false,command),before=copy(payload.pipeline),candidate=dashboard(intent,true);
    const wrong=Review.evidence(payload,{crmAction:candidate});
    assert.equal(wrong.displayed[0].summaries[0].value,1/7*100);
    assert.equal(wrong.displayed[1].summaries[0].value,1/6*100);
    const h=harness(()=>proposal(candidate),(input,body)=>{
      assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','userCommand']);
      assert.equal(input.userCommand,command);assert.equal(body.text.format.strict,true);
      assert.doesNotMatch(JSON.stringify(input),/PRIVATE_PLANNER_PROSE|PRIVATE_UNRELATED_RECORD|QA1110 Deal 1/);
      assert.equal(h.evidence.length,0,'Independent extraction precedes candidate execution');
      return intent;
    });
    const result=await h.plan(payload);
    assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat],'No planner retry or general review is needed');
    assert.equal(h.preparations.length,1);assert.equal(h.evidence.length,1);assert.equal(h.assessments.length,1);
    const [rebound]=h.evidence,[verified]=h.assessments,prepared=h.preparations[0].prepared;
    assert.deepEqual(result.crmAction,Ratio.compile(intent,payload.pipeline));
    assert.strictEqual(rebound.payload,payload);assert.strictEqual(rebound.action,result.crmAction);
    assert.notStrictEqual(rebound.action,candidate);
    assert.notStrictEqual(rebound.computed,prepared.computed,'Server must rebuild evidence with the actual request payload');
    assert.strictEqual(verified.context.computed,rebound.computed);assert.strictEqual(verified.context.pipeline,payload.pipeline);
    assert.deepEqual(verified.checked,{complete:true,ok:true,issues:[],requested:2,compiled:2});
    assert.strictEqual(result.lifecycle,rebound.computed.lifecycle);
    assert.equal(result.lifecycle.operation,'read');assert.equal(result.lifecycle.requiresConfirmation,false);assert.equal(result.lifecycle.writesApplied,0);
    assert.deepEqual(result.coverage,{requested:2,compiled:2});
    assert.deepEqual(result.crmAction.steps.flatMap(step=>step.spec.measures.map(measure=>measure.metric)),['count','count','sum','sum']);
    assert(result.crmAction.steps.every(step=>step.op==='report'&&step.showDashboard===false));
    assert(rebound.computed.effects.every(effect=>effect.kind==='table'&&effect.show===false));
    assert.equal(h.renders.length,1);assert.strictEqual(h.renders[0].computed,rebound.computed);
    assert.strictEqual(h.renders[0].action,result.crmAction);
    assert.match(result.computedAnswer,/14\.29% \(1 \/ 7 x 100\)/);
    assert.match(result.computedAnswer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
    assert.match(result.computedAnswer,/7 records represented/);assert.match(result.computedAnswer,/6 numeric values/);
    assert.doesNotMatch(result.computedAnswer,/16\.67%|PRIVATE_PLANNER_PROSE/);
    assert.deepEqual(h.events,[plannerFormat,'normalize',ratioFormat,'prepare','evidence','assess']);
    assert.deepEqual(h.otherChecks,[]);
    assert.equal(h.validations.length,0);assert.deepEqual(h.logs,[]);assert.deepEqual(payload.pipeline,before);
  }
});

function rawOperandPlan(intent){
  return F.plan([F.select('cohort',copy(intent.ratios[0].population.where)),
    {id:'raw_count',op:'read_records',label:'Count operands',selection:'cohort',showTable:false,outputs:[{kind:'count',field:null}]},
    {id:'raw_value',op:'read_records',label:'Value operands',selection:'cohort',showTable:false,outputs:[{kind:'sum',field:'f_value'}]}]);
}

function answerReview(action){
  return {requirements:action.steps.map(step=>({description:step.label,evidenceKind:'computed_read',
    stepIds:[step.id+'/percentage:0'],requiredOutputs:['percentages','numerator','denominator',step.spec.measures[0].metric],satisfied:true})),
    issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null,presentationIntent:{status:'not_requested',elements:[]}};
}

test('ordinary planner exposes compact ratio transport and normalizes it before independent extraction and fresh evidence',async()=>{
  for(const omitted of [false,true]){
    const {payload,intent}=fixture(),before=copy(payload.pipeline),transport={action:'ratio_transport',ratios:copy(intent.ratios)};
    if(omitted)transport.ratios.pop();
    const h=harness((input,body)=>{
      assert(input.supportedActions.includes('ratio_transport'));
      const schema=body.text.format.schema.properties.crmAction.anyOf.find(branch=>branch.properties?.action?.enum?.includes('ratio_transport'));
      assert.deepEqual(schema,Ratio.transportSchemaFor(payload.pipeline));
      assert(body.instructions.includes(Ratio.compilerInstructions));
      return proposal(transport);
    },input=>{
      assert.equal(h.normalizations.length,1);assert.equal(h.evidence.length,0);
      assert.deepEqual(h.normalizations[0].action,transport);
      assert.equal(h.normalizations[0].normalized.action,'workspace_plan');
      assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','userCommand']);
      assert.doesNotMatch(JSON.stringify(input),/PRIVATE_PLANNER_PROSE|PRIVATE_UNRELATED_RECORD|QA1110 Deal 1|ratio_transport/);
      return intent;
    });
    const result=await h.plan(payload);
    assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat]);
    assert.deepEqual(h.events,[plannerFormat,'normalize',ratioFormat,'prepare','evidence','assess']);
    assert.equal(h.preparations.length,1);assert.equal(h.evidence.length,1);assert.equal(h.assessments.length,1);
    assert.deepEqual(result.crmAction,Ratio.compile(intent,payload.pipeline));
    assert.deepEqual(result.coverage,{requested:2,compiled:2});
    assert.strictEqual(h.assessments[0].context.computed,h.evidence[0].computed);
    assert.notStrictEqual(h.evidence[0].computed,h.preparations[0].prepared.computed);
    assert.match(result.computedAnswer,/14\.29% \(1 \/ 7 x 100\)/);
    assert.match(result.computedAnswer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
    assert.deepEqual(h.otherChecks,[]);assert.deepEqual(h.logs,[]);assert.deepEqual(payload.pipeline,before);
  }
});

test('server repairs omitted percentage outputs before executing raw operands',async()=>{
  for(const command of commands){
    const {payload,intent}=fixture(false,command),before=copy(payload.pipeline),candidate=rawOperandPlan(intent);
    const h=harness(()=>proposal(candidate),input=>{
      assert.equal(input.userCommand,command);
      assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','userCommand']);
      assert.equal(h.evidence.length,0);
      return intent;
    });
    const result=await h.plan(payload);
    assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat]);
    assert.equal(h.preparations.length,1);assert.equal(h.evidence.length,1);assert.equal(h.assessments.length,1);
    assert.deepEqual(result.coverage,{requested:2,compiled:2});
    assert.match(result.computedAnswer,/14\.29% \(1 \/ 7 x 100\)/);
    assert.match(result.computedAnswer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
    assert.strictEqual(h.renders[0].computed,h.evidence[0].computed);
    assert.notStrictEqual(h.renders[0].computed,h.preparations[0].prepared.computed);
    assert.deepEqual(h.otherChecks,[]);
    assert.deepEqual(h.logs,[]);assert.deepEqual(payload.pipeline,before);
  }
});

test('broader candidate extraction defers ordinary totals without inventing or approving percentage intent',async()=>{
  const {payload,intent}=fixture(),candidate=rawOperandPlan(intent);
  payload.userCommand='Count QA1110 deals and total their known Deal Value.';
  const h=harness(()=>proposal(candidate),()=>({completeIntent:false,otherRequestedWork:true,ambiguity:false,ratios:[]}),
    ()=>({requirements:[
      {description:'Count records',stepIds:['raw_count'],requiredOutputs:['count'],evidenceKind:'computed_read',satisfied:true},
      {description:'Total known value',stepIds:['raw_value'],requiredOutputs:['sum'],evidenceKind:'computed_read',satisfied:true}
    ],issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null,presentationIntent:{status:'not_requested',elements:[]}}));
  const result=await h.plan(payload);
  assert.equal(h.validations[0].checked.ok,true,JSON.stringify(h.validations[0].checked));
  assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat,reviewFormat]);
  assert.equal(h.preparations.length,0);assert.equal(h.assessments.length,0);
  assert.equal(h.evidence.length,1);assert.equal(h.validations.length,1);assert(h.otherChecks.length>0);
  assert(h.events.indexOf(ratioFormat)<h.events.indexOf('evidence'));
  assert.deepEqual(result.crmAction,candidate);assert.deepEqual(result.coverage,{requested:2,compiled:2});
});

test('complete independent ratio intent recovers uncovered operations before candidate evidence can throw',async()=>{
  for(const command of commands){
    const {payload,intent}=fixture(false,command),before=copy(payload.pipeline),candidate=Ratio.compile(intent,payload.pipeline);
    candidate.goals.pop();
    assert.throws(()=>Review.evidence(payload,{crmAction:candidate}),error=>
      error.reasonCode==='goal_coverage_invalid'&&error.goalCoverage.uncoveredOperations===1);
    const h=harness(()=>proposal(candidate),()=>{
      assert.equal(h.evidence.length,0);return intent;
    });
    const result=await h.plan(payload);
    assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat]);
    assert.equal(h.preparations.length,1);assert.equal(h.evidence.length,1);assert.equal(h.assessments.length,1);
    assert.deepEqual(result.crmAction,Ratio.compile(intent,payload.pipeline));
    assert.deepEqual(result.coverage,{requested:2,compiled:2});
    assert.match(result.computedAnswer,/14\.29% \(1 \/ 7 x 100\)/);
    assert.match(result.computedAnswer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
    assert.deepEqual(h.otherChecks,[]);assert.deepEqual(h.logs,[]);assert.deepEqual(payload.pipeline,before);
  }
});

test('complete ratio intent cannot be preempted by an executable derived-total candidate',async()=>{
  const {payload,intent}=fixture(),candidate=rawOperandPlan(intent);
  candidate.steps[2].outputs=[{kind:'row_calculation',expression:{kind:'sum_product',factors:['f_value'],divisor:1}}];
  assert.equal(require('../lib/derived-calculation-intent').eligible(candidate),true);
  assert.doesNotThrow(()=>Review.evidence(payload,{crmAction:candidate}));
  const h=harness(()=>proposal(candidate),()=>{
    assert.equal(h.evidence.length,0);return intent;
  });
  const result=await h.plan(payload);
  assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat]);
  assert.deepEqual(h.otherChecks,[]);assert.equal(h.preparations.length,1);assert.equal(h.evidence.length,1);
  assert.deepEqual(result.coverage,{requested:2,compiled:2});
  assert.deepEqual(result.crmAction,Ratio.compile(intent,payload.pipeline));
});

test('server blocks an incorrect partial ratio before general review and never locally drops its display obligations',async()=>{
  const {payload,intent}=fixture(true),before=copy(payload.pipeline),candidate=dashboard(intent,true);let attempts=0;
  const h=harness(input=>{
    if(attempts++){
      assert.match(input.compilerRepair.issues.join('\n'),/value share requires sum\/sum/);
      assert.equal(input.compilerRepair.expectedAction,undefined);
    }
    return proposal(candidate);
  },()=>intent);
  const result=await h.plan(payload);
  assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat,plannerFormat,ratioFormat]);
  assert.equal(attempts,2);assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);
  assert.equal(result.computedAnswer,undefined);assert.equal(result.coverage,undefined);
  assert.equal(h.preparations.length,0);assert.equal(h.validations.length,0);assert.equal(h.renders.length,0);
  assert.equal(h.assessments.length,2);assert(h.assessments.every(({intent,checked})=>intent.completeIntent===false&&checked.complete&&
    checked.ok===false&&checked.expectedAction===undefined));
  assert(h.evidence.every(item=>item.action.action==='dashboard_plan'));
  assert.deepEqual(h.otherChecks,[]);
  assert.deepEqual(h.logs.map(log=>[log.attempt,log.stage,log.counts.requested,log.counts.compiled]),[[0,'mapping',2,0],[1,'mapping',2,0]]);
  assert.deepEqual(payload.pipeline,before);
});

test('a correct partial ratio reaches real general review, whose remaining display verdict still controls acceptance',async()=>{
  for(const satisfied of [true,false]){
    const {payload,intent}=fixture(true),before=copy(payload.pipeline),candidate=dashboard(intent);
    const h=harness(()=>proposal(candidate),()=>intent,(input,body)=>{
      assert.deepEqual(input.compiled,candidate);assert.deepEqual(input.computed,copy(h.evidence[0].computed));
      assert.equal(body.text.format.name,reviewFormat);
      assert(input.allowedStepIds.includes('percentage:0'));assert(input.allowedStepIds.includes('percentage:1'));
      assert(input.allowedStepIds.includes('graph:share_0'));assert(input.allowedStepIds.includes('graph:share_1'));
      assert.match(input.computed.answer,/14\.29% \(1 \/ 7 x 100\)/);
      assert.match(input.computed.answer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
      return displayReview(candidate,satisfied);
    });
    // Keep rejection focused on this review, without another planner attempt.
    const result=await h.plan(payload,satisfied?Date.now():Date.now()-60000);
    assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat,reviewFormat]);
    assert.equal(h.preparations.length,0);assert.equal(h.evidence.length,1);assert.equal(h.assessments.length,1);
    assert.deepEqual(h.otherChecks,[],'Partial ratio proof cannot authorize another bounded checker to approve the whole request');
    assert.deepEqual(h.assessments[0].checked,{complete:false,ok:true,issues:[],requested:2,compiled:2,requiresGeneralReview:true});
    assert.equal(h.validations.length,1);assert.equal(h.validations[0].checked.ok,satisfied);
    assert.strictEqual(h.validations[0].context.computed,h.evidence[0].computed);
    if(satisfied){
      assert.deepEqual(result.crmAction,candidate);assert.deepEqual(result.coverage,{requested:3,compiled:3});
      assert.strictEqual(result.lifecycle,h.evidence[0].computed.lifecycle);
      assert.equal(result.lifecycle.writesApplied,0);assert.equal(result.lifecycle.requiresConfirmation,false);
      assert.equal(result.computedAnswer,h.evidence[0].computed.answer);
      assert.equal(h.renders.length,1);assert.strictEqual(h.renders[0].computed,h.evidence[0].computed);
      assert.deepEqual(h.logs,[]);
    }else{
      assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
      assert.equal(h.renders.length,0);assert.equal(h.logs.length,1);assert.equal(h.logs[0].counts.compiled,2);
    }
    assert.deepEqual(payload.pipeline,before);
  }
});

test('answer-only fractions do not discard an additional display obligation from partial independent intent',async()=>{
  const {payload,intent}=fixture(true),before=copy(payload.pipeline);
  const candidate=Ratio.compile({...intent,completeIntent:true,otherRequestedWork:false},payload.pipeline);
  const h=harness(()=>proposal(candidate),()=>intent,input=>{
    assert.deepEqual(input.compiled,candidate);
    const review=answerReview(candidate);
    review.requirements.push({description:'Two separate temporary dashboard panels',evidenceKind:'computed_read',
      stepIds:candidate.steps.map(step=>step.id),requiredOutputs:['separate_widgets'],satisfied:false});
    review.issues=['The requested dashboard panels are absent.'];
    review.presentationIntent=displayReview(dashboard(intent)).presentationIntent;
    return review;
  });
  const result=await h.plan(payload,Date.now()-60000);
  assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat,reviewFormat]);
  assert.equal(h.preparations.length,0);assert.equal(h.evidence.length,1);assert.equal(h.assessments.length,1);
  assert.equal(h.assessments[0].checked.requiresGeneralReview,true);assert.deepEqual(h.otherChecks,[]);
  assert.equal(h.validations[0].checked.ok,false);assert.equal(h.validations[0].checked.requested,3);assert.equal(h.validations[0].checked.compiled,2);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
  assert.equal(h.renders.length,0);assert.deepEqual(payload.pipeline,before);
});

for(const [label,verdict] of [['empty object',{}],['non-array ratios',{
  completeIntent:false,otherRequestedWork:true,ambiguity:false,ratios:null
}]])test('malformed '+label+' ratio verdict cannot fall through to generic approval',async()=>{
  const {payload,intent}=fixture(),candidate=Ratio.compile(intent,payload.pipeline);
  const h=harness(()=>proposal(candidate),()=>verdict,()=>answerReview(candidate));
  const result=await h.plan(payload,Date.now()-60000);
  assert.equal(result.outcome,'validation_failed');assert.equal(result.crmAction,null);assert.equal(result.computedAnswer,undefined);
  assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat]);
  assert.equal(h.preparations.length,0);assert.equal(h.validations.length,0);assert.equal(h.renders.length,0);
  assert.deepEqual(h.otherChecks,[]);
});

test('null ratio response rejects at the provider boundary without generic review or candidate execution',async()=>{
  const {payload,intent}=fixture(),candidate=Ratio.compile(intent,payload.pipeline);
  const h=harness(()=>proposal(candidate),()=>null);
  await assert.rejects(()=>h.plan(payload,Date.now()-60000),error=>error.status===502);
  assert.deepEqual(h.calls.map(call=>call.name),[plannerFormat,ratioFormat,ratioFormat],'Provider parsing permits one bounded model fallback');
  assert.equal(h.evidence.length,0);assert.equal(h.preparations.length,0);assert.equal(h.validations.length,0);assert.equal(h.renders.length,0);
  assert.deepEqual(h.otherChecks,[]);
});
