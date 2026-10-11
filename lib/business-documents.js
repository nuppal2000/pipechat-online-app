'use strict';

const {createHash} = require('node:crypto');
const Actions = require('../public/business-actions');
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

function artifact(action, factBundle) {
  const output = Actions.documentArtifact(action, factBundle);
  return {...output, byteLength:Buffer.byteLength(output.body, 'utf8'), sha256:digest(output.body)};
}

function plan(action, factBundle) {
  Actions.validateDocumentAction(action);
  const proposal = Actions.plan(action, {factBundle});
  return {...proposal, sourceHash:digest(JSON.stringify(proposal.source)), artifact:artifact(action, factBundle)};
}

// Store the reviewed proposal server-side. Rebuild from fresh canonical facts at apply;
// never serve a body submitted by the browser or model. No disk or network IO occurs.
function apply(proposal, factBundle) {
  if (proposal?.kind !== 'document') throw new Error('Invalid document proposal.');
  const current = plan(proposal.action, factBundle);
  if (current.sourceHash !== proposal.sourceHash) throw new Error('The canonical record changed. Review a new document before downloading.');
  return current.artifact;
}

function downloadResponse(action, factBundle) {
  const output = artifact(action, factBundle);
  return {status:200, headers:{
    'Content-Type':output.mimeType,
    'Content-Disposition':`attachment; filename="${output.filename}"`,
    'Content-Length':String(output.byteLength),
    'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'Cache-Control':'private, no-store'
  }, body:output.body};
}

module.exports = {plan, apply, artifact, downloadResponse};
