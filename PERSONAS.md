# Workspace personas: phase one

Personas are communication context, not permission to act. The existing router,
grounding, structured action plans, completeness review, confirmation, persistence
and usage accounting remain authoritative.

## Selection and storage

- Sales, Recruiting and Real Estate use the existing onboarding choice.
- Other is classified semantically during the existing AI setup/type-analysis
  response. There is no additional classification request. Unclear or mixed
  businesses use the neutral profile. Insurance is an available Other profile.
- `lib/agent-persona.js` owns the reviewed profiles and version (`v1`). Descriptions
  and inferred subtypes remain data, never concatenated developer instructions.
- Migration `023-workspace-personas.sql` stores a validated assignment per owned
  workspace, with RLS and authenticated, owner-scoped RPCs. There are no direct
  client table grants. JSON development storage uses a separate per-user file.
- Assignments are pinned for the same business context. Column renaming and other
  CRM edits do not reclassify the workspace. Reset clears the assignment, not the
  chat allowance. Existing workspaces are not bulk rewritten or backfilled.
- An onboarding preview can save persona metadata, but does not create a table or
  records. The current table-confirmation step is still required. Spreadsheet
  confirmation also establishes a fallback assignment if no AI analysis ran.

## Request path

1. Authenticate and load the current authoritative workspace.
2. Read its compatible saved assignment, otherwise derive a safe fallback from
   the current setup/business context. Ignore client-supplied persona overrides.
3. Add the common safety policy and selected versioned profile to either model's
   prompt; add business context to the structured input as untrusted data.
4. Run the existing planner, escalation and reviewer. Extract optional setup
   classification before validating the unchanged action contract.
5. Save new assignment metadata using the workspace revision. A concurrent schema
   change rejects stale metadata. Return the action outcome and separate persona
   presentation metadata; never execute a CRM action as a side effect.

The profile adds tone, domain vocabulary and relevant advice. Actual field labels,
user intent, computed evidence and confirmation rules win over domain conventions.
Computed reports, exact saved-note retrieval and lifecycle receipts are not rewritten
by an extra model. A metadata outage cannot turn a failed action into success or
block a completed local CRM save; it is retried on a subsequent request.

## Verification

- `test/agent-persona.test.js`: immutable profiles, inference/uncertainty, prompt
  trust boundaries, schema compatibility and isolation.
- `test/agent-persona-sql.test.js`: full migration chain, owner isolation, pins,
  stale versions, reset, unchanged allowance, grants and revoked sessions.
- `test/agent-persona-server.test.js`: full server setup/confirmation/relogin,
  both router tiers and rejected client prompt overrides with an offline fixture.
- Real endpoint acceptance is separate: confirm onboarding and reload in a new
  disposable account; compare domain-appropriate advice; check a proposed edit
  still requires confirmation and cancellation leaves data unchanged.

Future profile versions must retain definitions for existing pins and provide an
explicit upgrade path. Workspace-defined rules, free-form system prompts, persona
management settings and autonomous execution are not part of phase one.
