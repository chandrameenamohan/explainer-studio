# Agent SDK findings (2026-10-12T20:15:06.584Z)

- A streamed deltas: true
- init carried session_id: true
- resume carried context: true
- bogus resume result: isError=true startupFailure=null errors=No conversation found with session ID: 00000000-0000-0000-0000-000000000000

## Log

- A: raw {"type":"system","subtype":"init","cwd":"<repo>/examples/sd-model-serving","session_id":"e322ce46-eeb2-41c1-b908-28542ce95656","tools":["CronCreate","CronDelete","CronList","DesignSync","EnterWorktree","ExitWorktree","Glob","Grep","ListAgents","Monitor","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskStop","ToolSearch","Workflow"], ...} (rest of init trimmed)
- A: {"type":"init","sessionId":"e322ce46-eeb2-41c1-b908-28542ce95656","model":"claude-fable-5-1"}
- A: raw {"type":"system","subtype":"status","status":"requesting","session_id":"e322ce46-eeb2-41c1-b908-28542ce95656","uuid":"fdc4f197-d207-47e8-9f1f-49f4d9bc023c"}
- A: raw {"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-fable-5-1","id":"msg_011CfxxRoRAWVCpnViLTQtHE","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":13098,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":13098},"output_tokens":16,"service_tier":"standard","inference_geo":"global"},"input_transformations":[],"diagnostics":null,"context_management":null}},"session_id":"e322ce46-eeb2
- A: {"type":"tool","name":"Read","input":{"file_path":"<repo>/examples/sd-model-serving/script.json"}}
- A: {"type":"delta","text":"The hard part is r"}
- A: {"type":"delta","text":"olling out a"}
- A: {"type":"delta","text":" new version safely: a model can"}
- A: {"type":"delta","text":" be healthy as a service y"}
- A: {"type":"delta","text":"et wrong as a model,"}
- A: {"type":"delta","text":" so the rollout gate must"}
- A: {"type":"delta","text":" watch a quality metric ("}
- A: {"type":"delta","text":"not"}
- A: {"type":"delta","text":" just latency and"}
- A: {"type":"delta","text":" errors) and auto-r"}
- A: {"type":"delta","text":"ollback before"}
- A: {"type":"delta","text":" the"}
- A: {"type":"delta","text":" bad version reaches every"}
- A: {"type":"delta","text":"one."}
- A: {"type":"text","text":"The hard part is rolling out a new version safely: a model can be healthy as a service yet wrong as a model, so the rollout gate must watch a quality metric (not just latency and errors) and auto-rollback before the bad version reaches everyone."}
- A: {"type":"result","sessionId":"e322ce46-eeb2-41c1-b908-28542ce95656","costUsd":0.41123060000000006,"isError":false,"errors":[],"startupFailure":null,"resultText":"The hard part is rolling out a new version safely: a model can be healthy as a service yet wrong as a model, so the rollout gate must watch a quality metric (not just latency and errors) and auto-rollback before the bad version reaches ev
- B: raw {"type":"system","subtype":"init","cwd":"<repo>/examples/sd-model-serving","session_id":"e322ce46-eeb2-41c1-b908-28542ce95656","tools":["CronCreate","CronDelete","CronList","DesignSync","EnterWorktree","ExitWorktree","Glob","Grep","ListAgents","Monitor","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskStop","ToolSearch","Workflow"], ...} (rest of init trimmed)
- B: {"type":"init","sessionId":"e322ce46-eeb2-41c1-b908-28542ce95656","model":"claude-fable-5-1"}
- B: raw {"type":"system","subtype":"status","status":"requesting","session_id":"e322ce46-eeb2-41c1-b908-28542ce95656","uuid":"fcdbddd6-c37d-47b2-ae07-f4db47dfee65"}
- B: raw {"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-fable-5-1","id":"msg_011CfxxSB3SESYxc7GiEzyaS","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":560,"cache_read_input_tokens":19972,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":560},"output_tokens":4,"service_tier":"standard","inference_geo":"global"},"input_transformations":[],"diagnostics":null,"context_management":null}},"session_id":"e322ce46-eeb2-
- B: {"type":"delta","text":"You asked:"}
- B: {"type":"delta","text":" \"What is the one hard part"}
- B: {"type":"delta","text":" of this design, in one sent"}
- B: {"type":"delta","text":"ence?\""}
- B: {"type":"text","text":"You asked: \"What is the one hard part of this design, in one sentence?\""}
- B: {"type":"result","sessionId":"e322ce46-eeb2-41c1-b908-28542ce95656","costUsd":0.42869360000000006,"isError":false,"errors":[],"startupFailure":null,"resultText":"You asked: \"What is the one hard part of this design, in one sentence?\""}
- C: raw {"type":"result","subtype":"error_during_execution","duration_ms":0,"duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"00000000-0000-0000-0000-000000000000","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard","fallback_credit
- C: {"type":"result","sessionId":"00000000-0000-0000-0000-000000000000","costUsd":0,"isError":true,"errors":["No conversation found with session ID: 00000000-0000-0000-0000-000000000000"],"startupFailure":null,"resultText":null}
