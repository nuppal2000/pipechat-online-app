'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const Documents = require('../lib/business-documents');
const Actions = require('../public/business-actions');
const action = {action:'create_document', recordId:73, documentType:'proposal', format:'html'};
const bundle = () => ({recordId:73, recordName:'Selected record', revision:'fixture-r1', facts:[
  {id:'f_scope', label:'Requested scope', value:'Assess the provided requirements'},
  {id:'f_value', label:'Recorded value', value:4500},
  {id:'f_note', label:'Note', value:'Needs review'}
], terms:{scope:'f_scope'}});

test('proposal is a real downloadable artifact, not a none action or narrative placeholder', () => {
  const facts = bundle(), before = structuredClone(facts), proposal = Documents.plan(action, facts);
  assert.equal(proposal.kind, 'document');
  assert.equal(proposal.count, 1);
  assert.equal(proposal.artifact.filename, 'proposal-record-73.html');
  assert.equal(proposal.artifact.mimeType, 'text/html; charset=utf-8');
  assert.equal(proposal.artifact.encoding, 'utf-8');
  assert.match(proposal.artifact.body, /^<!doctype html>/);
  assert.match(proposal.artifact.body, /Assess the provided requirements/);
  assert.match(proposal.artifact.body, /@media print/);
  assert.deepEqual(facts, before);
  assert.deepEqual(Documents.apply(JSON.parse(JSON.stringify(proposal)), facts), proposal.artifact);
  assert.equal(proposal.artifact.byteLength, Buffer.byteLength(proposal.artifact.body));
  assert.equal(proposal.artifact.sha256, createHash('sha256').update(proposal.artifact.body).digest('hex'));
});

test('critical terms remain explicitly Unknown unless a canonical fact is explicitly mapped', () => {
  const facts = bundle(), proposal = Documents.plan(action, facts);
  const terms = Object.fromEntries(proposal.preview.terms.map(term => [term.key, term.value]));
  assert.equal(terms.scope, facts.facts[0].value);
  for (const key of ['provider','price','currency','paymentTerms','timeline','validUntil','taxes','exclusions']) assert.equal(terms[key], 'Unknown');
  assert.equal(proposal.preview.unknownTerms.length, 8);
  assert.match(proposal.artifact.body, /<th scope="row">Price<\/th><td>Unknown<\/td>/);
  assert.doesNotMatch(proposal.artifact.body, /USD|Net 30|30 days|10%|\$4,500/);
  facts.terms.price = 'f_value';
  const explicit = Documents.plan(action, facts);
  assert.equal(explicit.preview.terms.find(term => term.key === 'price').value, '4500');
  assert.equal(explicit.preview.terms.find(term => term.key === 'currency').value, 'Unknown');
  assert.equal(explicit.preview.terms.find(term => term.key === 'price').sourceFactId, 'f_value');
});

test('empty terms do not erase Unknown and explicit zero/false facts are preserved', () => {
  const facts = bundle();
  facts.facts = [
    {id:'f_zero', label:'Quoted price', value:0}, {id:'f_false', label:'Tax included', value:false},
    {id:'f_blank', label:'Currency', value:' \n'}, {id:'f_null', label:'Payment', value:null}
  ];
  facts.terms = {price:'f_zero', taxes:'f_false', currency:'f_blank', paymentTerms:'f_null'};
  const preview = Documents.plan(action, facts).preview;
  assert.equal(preview.terms.find(term => term.key === 'price').value, '0');
  assert.equal(preview.terms.find(term => term.key === 'taxes').value, 'false');
  assert.equal(preview.terms.find(term => term.key === 'currency').value, 'Unknown');
  assert.equal(preview.terms.find(term => term.key === 'paymentTerms').value, 'Unknown');
});

test('all source content is escaped; filenames and headers cannot carry user text', () => {
  const facts = bundle(), payload = '</td></tr><script src="https://invalid.example/x">alert(1)</script><img onerror="x">&\'';
  facts.recordName = '../../report.html\r\nX-Forged: value ' + payload;
  facts.revision = payload;
  facts.facts[0].label = payload;
  facts.facts[0].value = payload;
  const response = Documents.downloadResponse(action, facts);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Disposition'], 'attachment; filename="proposal-record-73.html"');
  assert.equal(response.headers['Content-Length'], String(Buffer.byteLength(response.body)));
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(response.headers['Content-Security-Policy'], /sandbox/);
  assert.match(response.body, /&lt;script src=&quot;/);
  assert.doesNotMatch(response.body, /<script|<img|<iframe|<a\s|<link|<form/i);
  assert.match(response.body, /default-src 'none'/);
  assert.deepEqual(Object.keys(response), ['status','headers','body']);
});

test('artifact bytes and body preserve Unicode safely', () => {
  const facts = bundle();
  facts.recordName = '\u6771\u4eac \u00e9';
  const output = Documents.artifact(action, facts);
  assert.match(output.body, /\u6771\u4eac \u00e9/);
  assert.equal(output.byteLength, Buffer.byteLength(output.body, 'utf8'));
  assert.ok(output.byteLength > output.body.length);
});

test('apply rechecks every canonical fact, term reference, identity and revision', () => {
  const facts = bundle(), proposal = Documents.plan(action, facts);
  for (const mutate of [
    value => { value.revision = 'fixture-r2'; }, value => { value.recordName = 'Changed'; },
    value => { value.facts[0].value = 'Changed'; }, value => { value.terms.price = 'f_value'; }
  ]) {
    const changed = structuredClone(facts); mutate(changed);
    assert.throws(() => Documents.apply(proposal, changed), /changed/);
  }
  assert.throws(() => Documents.apply(proposal, {...facts, recordId:74}), /does not match/);
  const forged = {...proposal, artifact:{body:'<script>forged</script>'}};
  assert.deepEqual(Documents.apply(forged, facts), proposal.artifact);
});

test('rejects invented prose, external delivery, PDFs without a renderer and invalid bundles', () => {
  for (const patch of [{body:'invented'}, {price:99}, {sendTo:'someone'}, {format:'pdf'}, {recordId:-1}, {recordId:74}]) {
    assert.throws(() => Documents.plan({...action, ...patch}, bundle()));
  }
  for (const mutate of [
    value => { value.terms.price = 'missing'; }, value => { value.terms.paymentTerms = 'Net 30'; },
    value => { value.terms.arbitrary = null; }, value => { value.facts.push(value.facts[0]); },
    value => { value.facts[0].value = {html:'<b>bad</b>'}; }, value => { value.facts[0].value = NaN; },
    value => { value.facts[0].id = '__proto__'; }, value => { value.hiddenHistory = 'not canonical'; }
  ]) { const facts = bundle(); mutate(facts); assert.throws(() => Documents.plan(action, facts)); }
});

test('browser and server derive the same preview and artifact from only provided facts', () => {
  const facts = bundle();
  const browser = Actions.plan(action, {factBundle:facts});
  const server = Documents.plan(action, facts);
  assert.deepEqual(browser.preview, server.preview);
  for (const key of ['body','mimeType','filename','encoding']) assert.equal(browser.artifact[key], server.artifact[key]);
  assert.deepEqual(Actions.validateFactBundle({...facts, facts:[] , terms:{}}).facts, []);
});
