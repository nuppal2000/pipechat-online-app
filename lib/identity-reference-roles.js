'use strict';

const creation = new Set(['add','create']);
const objectWords = new Set(['task','tasks','todo','todos','card','cards','field','fields','column','columns']);
const prefixes = new Set(['a','an','the','new','another','blank','linked','unlinked','standalone','custom',
  'number','numeric','integer','decimal','text','string','date','time','datetime','dropdown','choice',
  'select','boolean','currency','percent','percentage','optional','required','to','do','-',
  'one','two','three','four','five','six','seven','eight','nine','ten']);
const markers = new Set(['named','called','titled']);
const directives = new Set(['add','create','set','change','update','delete','remove','move','assign','rename','put','make','edit','merge','link','unlink']);
const boundaries = new Set([',',';','\n','\r\n','&','and','or','but','then','also','plus','while','where',
  'when','before','after','except','unless','without']);
const attributes = new Set(['due','deadline','with','for','linked','assigned','on','using','from']);
const quoted = token => /^["'\u201c\u2018]/u.test(token.text) && token.text.length > 1;
const sentenceEnd = (token,text) => token.word==='.' && /\s|$/.test(text[token.end]||'');

// Return literal spans only for bounded, recognized creation clauses. Source
// selectors and every later clause remain in the identity guard's input.
function creationLiteralRanges(text, tokens, knownSource) {
  const ranges=[];
  for(let i=0;i<tokens.length;i++) {
    const verb=tokens[i];
    if(!creation.has(verb.word)||!/(?:^|[.;,\n]|\b(?:and|then|also|but)\b)\s*(?:please\s+)?$/i.test(text.slice(0,verb.start)))continue;
    let object=i+1;
    while(object<tokens.length && object<i+10 && (prefixes.has(tokens[object].word)||/^\d+$/.test(tokens[object].word)))object++;
    if(!objectWords.has(tokens[object]?.word))continue;
    const isTask=/^(?:task|todo|card)s?$/.test(tokens[object].word);
    for(let j=object+1;j<tokens.length && j<object+80 && tokens[j].start-tokens[object].end<=1000;j++) {
      const token=tokens[j];
      if(boundaries.has(token.word)||sentenceEnd(token,text))break;
      const titleMarker=['title','name'].includes(token.word) &&
        /\bwith\s+(?:the\s+)?$/i.test(text.slice(tokens[object].end,token.start));
      if(!markers.has(token.word)&&!titleMarker)continue;
      const prefix=text.slice(tokens[object].end,token.start).trim();
      let source=prefix.replace(/\s+with(?:\s+the)?$/i,'');
      const direct=!prefix || titleMarker && /^with\s*(?:the\s*)?$/i.test(prefix);
      if(!direct) {
        if(!isTask || !/^(?:for\s+|linked\s+to\s+)/i.test(source))continue;
        source=source.replace(/^(?:for\s+|linked\s+to\s+)/i,'')
          .replace(/^(?:the\s+)?(?:record|account|deal|client|company)\s+(?:(?:named|called)\s+)?/i,'');
        if(!knownSource(source))continue;
      }
      let start=j+1;
      if(titleMarker && tokens[start]?.word===':')start++;
      if(!tokens[start])break;
      let end=start;
      if(quoted(tokens[start]))end++;
      else while(end<tokens.length && end<start+80 && tokens[end].end-tokens[start].start<=1000 &&
        !boundaries.has(tokens[end].word) && !attributes.has(tokens[end].word) && !sentenceEnd(tokens[end],text) &&
        !(end>start && directives.has(tokens[end].word)))end++;
      const value=tokens.slice(start,end);
      if(!value.length)break;
      // A copied title/name can name another record; it is not literal data.
      if(!quoted(value[0]) && value.some(token=>['same','copy','copied','as','of','like'].includes(token.word)))break;
      ranges.push([value[0].start,value.at(-1).end]);
      break;
    }
  }
  return ranges;
}

module.exports={creationLiteralRanges};
