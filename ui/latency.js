// Delivery times derived from captured SSE events, never from headers or usage.
const present = (value) => typeof value === 'string' && value.length > 0;
const array = (value) => Array.isArray(value) ? value : [];

function contentKinds(block, visibleOnly) {
  if (!block || typeof block !== 'object') return [];
  switch (block.type) {
    case 'text': case 'output_text': case 'refusal':
      return present(block.text ?? block.refusal) ? ['text'] : [];
    case 'thinking':
      return present(block.thinking) ? ['reasoning'] : [];
    case 'summary_text': case 'reasoning_text':
      return present(block.text) ? ['reasoning'] : [];
    case 'redacted_thinking':
      return !visibleOnly && present(block.data) ? ['reasoning'] : [];
    case 'reasoning':
      return [
        ...array(block.summary).flatMap(part => contentKinds(part, visibleOnly)),
        ...array(block.content).flatMap(part => contentKinds(part, visibleOnly)),
        ...(!visibleOnly && present(block.encrypted_content) ? ['reasoning'] : []),
      ];
    case 'message':
      return Array.isArray(block.content) ? block.content.flatMap(part => contentKinds(part, visibleOnly)) : [];
    case 'function_call': case 'custom_tool_call': case 'tool_use':
      return present(block.name) || present(block.arguments) || present(block.input) ? ['tool'] : [];
    default: return [];
  }
}

function eventKinds(data, visibleOnly) {
  switch (data?.type) {
    case 'response.output_text.delta': case 'response.output_text.done':
      return present(data.delta ?? data.text) ? ['text'] : [];
    case 'response.refusal.delta': case 'response.refusal.done':
      return present(data.delta ?? data.refusal) ? ['text'] : [];
    case 'response.reasoning_summary_text.delta': case 'response.reasoning_summary_text.done':
    case 'response.reasoning_text.delta': case 'response.reasoning_text.done':
      return present(data.delta ?? data.text) ? ['reasoning'] : [];
    case 'response.function_call_arguments.delta': case 'response.function_call_arguments.done':
    case 'response.custom_tool_call_input.delta': case 'response.custom_tool_call_input.done':
      return present(data.delta ?? data.arguments ?? data.input) ? ['tool'] : [];
    case 'response.output_item.added': case 'response.output_item.done':
      return contentKinds(data.item, visibleOnly);
    case 'response.content_part.added': case 'response.content_part.done':
    case 'response.reasoning_summary_part.added': case 'response.reasoning_summary_part.done':
      return contentKinds(data.part, visibleOnly);
    case 'response.completed': case 'response.incomplete': case 'response.failed':
      return array(data.response?.output).flatMap(item => contentKinds(item, visibleOnly));
    case 'message_start':
      return array(data.message?.content).flatMap(item => contentKinds(item, visibleOnly));
    case 'content_block_start':
      return contentKinds(data.content_block, visibleOnly);
    case 'content_block_delta':
      switch (data.delta?.type) {
        case 'text_delta': return present(data.delta.text) ? ['text'] : [];
        case 'thinking_delta': return present(data.delta.thinking) ? ['reasoning'] : [];
        case 'input_json_delta': return present(data.delta.partial_json) ? ['tool'] : [];
        default: return [];
      }
    default:
      return array(data?.choices).flatMap(choice => {
        const delta = choice?.delta ?? choice?.message;
        if (!delta) return [];
        return [
          ...(present(delta.content) || present(delta.refusal) ? ['text'] : []),
          ...(present(delta.reasoning_content) ? ['reasoning'] : []),
          ...(array(delta.tool_calls).some(call => present(call.function?.name) || present(call.function?.arguments)) ? ['tool'] : []),
        ];
      });
  }
}

/** Null means no timed SSE capture; individual null fields mean not observed. */
export function responseLatency(response, startedMs, visibleOnly = false) {
  if (!Array.isArray(response?.events) || !Number.isFinite(startedMs)) return null;
  const first = { content_ms: null, text_ms: null, reasoning_ms: null, tool_ms: null };
  for (const event of response.events) {
    if (!Number.isFinite(event.t) || event.t < startedMs) continue;
    let data;
    try { data = JSON.parse(event.data); } catch { continue; }
    for (const kind of eventKinds(data, visibleOnly)) {
      const elapsed = Math.round((event.t - startedMs) * 10) / 10;
      first.content_ms ??= elapsed;
      first[`${kind}_ms`] ??= elapsed;
    }
  }
  return first;
}
