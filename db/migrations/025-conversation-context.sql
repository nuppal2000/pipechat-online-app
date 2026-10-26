-- Read-only lifecycle context. No transcript parsing, recovery, or pending-action authority.
-- Requires 015; does not redefine completion semantics or modify account data.
begin;

create index conversation_turns_context on pipechat.conversation_turns
  (workspace_id,user_id,thread_id,finished_at desc,request_id)
  where status in ('succeeded','failed','cancelled','interrupted');

create function public.pipechat_read_conversation_outcomes(p_thread_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare uid uuid:=pipechat.require_user(); wid uuid:=pipechat.workspace_for(uid);
begin
  if p_thread_id is null then raise sqlstate 'PT400' using message='Invalid conversation ID.'; end if;
  if not exists(select 1 from pipechat.conversation_archives
    where workspace_id=wid and user_id=uid and id=p_thread_id) then
    raise sqlstate 'PT404' using message='Conversation unavailable.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'requestId',r.request_id,'userMessageId',r.user_message_id,'assistantMessageId',r.assistant_message_id,
    'status',r.status,'publicErrorCode',r.public_error_code,'finishedAt',pipechat.timestamp_text(r.finished_at))
    order by r.finished_at desc,r.request_id)
    from (
      select request_id,user_message_id,assistant_message_id,status,finished_at,
        -- Only the public enum is read from the private payload, never content or receipts.
        case
          when status='succeeded' and terminal_payload->>'publicErrorCode'='none' then 'none'
          when status='cancelled' and terminal_payload->>'publicErrorCode'='cancelled' then 'cancelled'
          when status='interrupted' and terminal_payload->>'publicErrorCode'='timeout' then 'timeout'
          when status='failed' and terminal_payload->>'publicErrorCode' in
            ('unknown','timeout','unavailable','invalid_response','validation','conflict','unauthorized','quota')
            then terminal_payload->>'publicErrorCode'
          else null
        end as public_error_code
      from pipechat.conversation_turns
      where workspace_id=wid and user_id=uid and thread_id=p_thread_id
        and status in ('succeeded','failed','cancelled','interrupted')
      order by finished_at desc,request_id limit 12
    ) r),'[]'::jsonb);
end $$;

revoke all on function public.pipechat_read_conversation_outcomes(uuid) from public,anon,authenticated,service_role;
grant execute on function public.pipechat_read_conversation_outcomes(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
