(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatRowCalculation=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const limits=Object.freeze({maxRows:2000,maxFactors:4,maxCellMagnitude:1e12,minDivisor:1e-12,maxDivisor:1e12,maxDecimalPlaces:18});
  const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const fail=message=>{const error=new Error(message);error.reasonCode='row_calculation_invalid';throw error;};
  const blank=value=>value==null||typeof value==='string'&&!value.trim();
  const numeric=field=>['number','currency'].includes(field.type);
  function responseSchema(core,customFields=[]){
    const fields=core.definitions(customFields).filter(numeric);
    if(!fields.length)return null;
    return object({kind:{type:'string',enum:['sum_product']},
      factors:{type:'array',minItems:1,maxItems:limits.maxFactors,items:{type:'string',enum:fields.map(f=>f.id)},
        description:'Existing numeric field IDs multiplied within each selected record. No formulas, labels, repeated fields or more than one currency factor.'},
      divisor:{type:'number',minimum:limits.minDivisor,maximum:limits.maxDivisor,
        description:'Explicit constant scale applied to each product before summing. Use 100 for percentages expressed as 0..100, 1 for fractions. Never infer scale from cell magnitudes.'}});
  }
  function validate(expression,core,customFields=[]){
    if(!expression||typeof expression!=='object'||Array.isArray(expression)||Object.keys(expression).some(k=>!['kind','factors','divisor'].includes(k))||
      expression.kind!=='sum_product')fail('Only a typed sum of row products with an explicit divisor is supported.');
    const {factors,divisor}=expression,defs=core.definitions(customFields);
    if(!Array.isArray(factors)||!factors.length||factors.length>limits.maxFactors||new Set(factors).size!==factors.length||
      Array.from(factors).some(id=>typeof id!=='string'||!defs.some(f=>f.id===id&&numeric(f))))fail('Choose one to four distinct existing numeric field IDs.');
    if(defs.filter(f=>factors.includes(f.id)&&f.type==='currency').length>1)fail('Products of multiple currency fields need an explicitly supported unit conversion.');
    if(typeof divisor!=='number'||!Number.isFinite(divisor)||divisor<limits.minDivisor||divisor>limits.maxDivisor)fail('Choose an explicit positive divisor from 1e-12 to 1e12.');
    decimal(divisor);
    return {kind:'sum_product',factors:[...factors],divisor};
  }
  const power=places=>10n**BigInt(places);
  const abs=n=>n<0n?-n:n;
  // Saved JSON numbers have bounded decimal representations. Multiplication
  // and alignment use integers; divide and round only after the complete sum.
  function decimal(value){
    const [mantissa,exponent='0']=String(value).toLowerCase().split('e'),parts=mantissa.split('.');
    let coefficient=BigInt(parts.join('')),scale=(parts[1]?.length||0)-Number(exponent);
    if(scale>limits.maxDecimalPlaces)fail('The numeric value exceeds the supported precision of 18 decimal places.');
    if(scale<0){coefficient*=power(-scale);scale=0;}
    return {coefficient,scale};
  }
  function fraction(product,divisor){
    let numerator=product.coefficient*power(divisor.scale),denominator=divisor.coefficient*power(product.scale);
    let a=abs(numerator),b=denominator;
    while(b){const rest=a%b;a=b;b=rest;}
    numerator/=a;denominator/=a;
    return {numerator,denominator};
  }
  const serialized=({numerator,denominator})=>({numerator:String(numerator),denominator:String(denominator)});
  function rounded(fraction,places){
    const {numerator,denominator}=fraction,scaled=abs(numerator)*power(places);
    let units=scaled/denominator;
    if(scaled%denominator*2n>=denominator)units++;
    const negative=numerator<0n&&units!==0n,digits=String(units).padStart(places+1,'0');
    const text=(negative?'-':'')+(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits),value=Number(text);
    if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)fail('The derived result exceeds the supported numeric range.');
    const roundTrip=decimal(value),signed=negative?-units:units;
    if(roundTrip.coefficient*power(places)!==signed*power(roundTrip.scale))fail('The derived result exceeds the supported numeric precision.');
    return {value,valueText:text};
  }
  function evaluate(records,input,core,customFields=[]){
    const expression=validate(input,core,customFields);
    if(!Array.isArray(records)||records.length>limits.maxRows)fail('Supply at most 2000 authorized selected records.');
    const defs=core.definitions(customFields),factors=expression.factors.map(id=>defs.find(f=>f.id===id)).map(({id,name,type})=>({id,name,type}));
    const type=factors.some(f=>f.type==='currency')?'currency':'number',places=type==='currency'?2:6,divisor=decimal(expression.divisor);
    const primary=core.role('primary'),seen=new Set(),contributions=[],excludedRows=[];
    let total={coefficient:0n,scale:0};
    for(const row of records){
      if(!row||!Number.isSafeInteger(row.id)||row.id<1||seen.has(row.id))fail('Selected record IDs must be unique positive safe integers.');
      seen.add(row.id);
      const name=blank(row[primary])?'Unnamed record #'+row.id:String(row[primary]),missingFields=[],values=[],numbers=[];
      for(const field of factors){
        const value=row[field.id];
        if(blank(value)){missingFields.push(field.id);continue;}
        if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>limits.maxCellMagnitude)fail('Record #'+row.id+' has an invalid numeric value in '+field.id+'. No calculation was produced.');
        numbers.push(decimal(value));values.push(value);
      }
      if(missingFields.length){excludedRows.push({recordId:row.id,name,missingFields});continue;}
      let product={coefficient:1n,scale:0};
      for(const n of numbers){product.coefficient*=n.coefficient;product.scale+=n.scale;}
      const exact=fraction(product,divisor),display=rounded(exact,places);
      const scale=Math.max(total.scale,product.scale);
      total={coefficient:total.coefficient*power(scale-total.scale)+product.coefficient*power(scale-product.scale),scale};
      contributions.push({recordId:row.id,name,values,...display,exact:serialized(exact)});
    }
    const exact=contributions.length?fraction(total,divisor):null;
    return {kind:'row_calculation',expression,factors,type,selectedRecordIds:[...seen],
      expressionText:'SUM(('+factors.map(f=>JSON.stringify(f.name)+' ['+f.id+']').join(' * ')+') / '+expression.divisor+')',
      ...(exact?rounded(exact,places):{value:null,valueText:null}),exactTotal:exact?serialized(exact):null,
      precision:{arithmetic:'decimal_from_json_numbers',decimalPlaces:places,rounding:'half_away_from_zero',roundingStage:'aggregate_after_sum',rowValues:'display_only'},
      coverage:{selectedCount:records.length,includedCount:contributions.length,excludedCount:excludedRows.length,excludedRows},contributions};
  }
  // Plain text only. HTML callers must escape it; complete row evidence stays in the result.
  function describe(result){
    const {coverage:c,precision:p}=result,display=result.value===null?'Not set':(result.type==='currency'?'$':'')+result.valueText;
    const excluded=c.excludedRows.slice(0,20).map(row=>JSON.stringify(row.name.length>200?row.name.slice(0,200)+'...':row.name)+' (#'+row.recordId+'): missing '+row.missingFields.join(', ')).join('; ');
    return result.expressionText+' = '+display+'.\n'+c.includedCount+' of '+c.selectedCount+' selected records included; '+c.excludedCount+' excluded for missing factors. Zeroes included; missing values are not zero.\n'+
      'Total rounded once after summing to '+p.decimalPlaces+' decimals (half away from zero); displayed row contributions are rounded separately, not summed.'+
      (excluded?'\nExcluded: '+excluded+(c.excludedCount>20?'; '+(c.excludedCount-20)+' more (complete exclusions in calculation evidence)':''):'');
  }
  return {limits,responseSchema,validate,evaluate,describe};
});
