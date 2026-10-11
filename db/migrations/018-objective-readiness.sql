begin;

-- Keep the legacy health fields and ACL unchanged. Only the new application
-- requires featureVersion 2; no function names or workspace data leave this RPC.
create or replace function public.pipechat_health() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare v integer; ready boolean;
begin
  select version into strict v from pipechat.schema_version where singleton;
  select not exists (
    select 1 from unnest(array[
      -- 013: entity workspaces and scoped sharing.
      'public.business_workspace_get(uuid)',
      'public.business_workspace_list()',
      'public.business_workspace_history(uuid,text,bigint)',
      'public.business_workspace_cas(uuid,bigint,jsonb,text)',
      'public.business_workspace_share(uuid,text,text,text,text,bigint)',
      'public.business_workspace_revoke(uuid,text,text,text,bigint)',
      -- 014: atomic actions, import receipts, undo and status-safe telemetry.
      'public.pipechat_commit_action(text,uuid,uuid,text,text,jsonb,jsonb)',
      'public.pipechat_commit_todo_action(text,uuid,uuid,text,text,jsonb,jsonb)',
      'public.pipechat_read_action(text)',
      'public.pipechat_undo_action(text,text,uuid,text)',
      'public.pipechat_list_actions(jsonb,integer)',
      'public.pipechat_record_beta_event(jsonb)',
      'public.pipechat_list_beta_events(integer,uuid)',
      -- 015: thread identity and durable turn lifecycle.
      'public.pipechat_list_conversation_threads()',
      'public.pipechat_new_conversation_thread(uuid,bigint,text)',
      'public.pipechat_switch_conversation_thread(uuid,bigint,uuid)',
      'public.pipechat_complete_conversation_turn(uuid,uuid,uuid,text)',
      'public.pipechat_begin_conversation_turn(uuid,uuid,bigint,uuid,uuid,uuid,integer)',
      'public.pipechat_finish_conversation_turn(uuid,uuid,text,text,text,jsonb)',
      'public.pipechat_read_conversation_turn(uuid,uuid)',
      'public.pipechat_recover_conversation_turns(integer)',
      -- 016: automation lifecycle and its canonical workspace entry points.
      'public.pipechat_read_workflows()',
      'public.pipechat_create_workflow(text,uuid,text,text,jsonb)',
      'public.pipechat_set_workflow_activation(text,uuid,text,text,bigint,boolean)',
      'public.pipechat_retry_workflow_event(text,uuid,text,text,text)',
      'public.pipechat_read_workspace()',
      'public.pipechat_write_workspace_v2(jsonb,jsonb,jsonb,text,jsonb)',
      'public.pipechat_write_crm(jsonb,jsonb,jsonb,text)'
    ]) as required(signature)
    where to_regprocedure(required.signature) is null
  ) into ready;
  return jsonb_build_object('ok',true,'contract','pipechat-supabase-v1','database','ok',
    'schemaVersion',v,'featureVersion',case when ready then 2 else 1 end);
end
$$;

commit;
