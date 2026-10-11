-- Copy-only change. Existing messages, turn statuses and function privileges remain intact.
begin;
create or replace function pipechat.conversation_terminal_payload(p_status text,p_error text,p_content text,p_receipt jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare content text;
begin
  if p_status is null or p_status not in ('succeeded','failed','cancelled','interrupted') then raise sqlstate 'PT400' using message='Invalid terminal status.'; end if;
  p_receipt:=nullif(p_receipt,'null'::jsonb);
  if p_status='succeeded' then
    if p_error is distinct from 'none' or p_content is null or pipechat.trim_text(p_content)='' or pipechat.js_length(p_content)>32000 then
      raise sqlstate 'PT400' using message='Invalid successful turn.';
    end if;
    perform pipechat.validate_conversation_state(jsonb_build_object('sourceAction',p_receipt));
    content:=p_content;
  else
    if p_content is not null or p_receipt is not null or p_error is null or
      (p_status='failed' and p_error not in ('unknown','timeout','unavailable','invalid_response','validation','conflict','unauthorized','quota')) or
      (p_status='cancelled' and p_error<>'cancelled') or (p_status='interrupted' and p_error<>'timeout') then
      raise sqlstate 'PT400' using message='Failures require a public error code, not raw provider text.';
    end if;
    content:=case when p_status='interrupted' then 'This request was interrupted before a durable result was saved. It was not rerun.'
      when p_status='cancelled' then 'The request was cancelled. Check saved activity for any completed changes.'
      else case p_error
        when 'unknown' then 'The request could not be completed. Check saved activity before trying again.'
        when 'timeout' then 'The request timed out before a durable reply was saved.'
        when 'unavailable' then 'The assistant is temporarily unavailable.'
        when 'invalid_response' then 'Sorry, I couldn''t prepare a reliable answer. Please try again or rephrase the request.'
        when 'validation' then 'Sorry, I couldn''t prepare every part of that request reliably. Please try again or narrow the request.'
        when 'conflict' then 'The workspace changed while this request was running.'
        when 'unauthorized' then 'The request could not be completed because access changed.'
        when 'quota' then 'The chat usage limit was reached.' end end;
  end if;
  return jsonb_build_object('status',p_status,'publicErrorCode',p_error,'content',content,'resultReceipt',p_receipt);
end $$;
commit;
