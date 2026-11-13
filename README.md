# Chat Interactions

A single-file Cloudflare Worker that translates OpenAI Chat Completions requests into Google's Interactions API and translates responses back into Chat Completions format.

Designed for **non-streaming, best-effort compatibility**: coerce inputs and preserve available output rather than reject requests for minor format differences. This is not a complete implementation of the OpenAI API.

## Files

- [`worker.js`](worker.js): the entire Worker, including request/response translation, tolerant JSON parsing, and fetch helpers.

No third-party runtime dependencies, package manifest, build step, or committed test suite are required or included. The `cloudflare:workers` import is provided by the Workers runtime.

## Deploy and connect

1. Create a Cloudflare Worker using the ES module format.
2. Paste the contents of `worker.js` into its entry module and deploy with a recent compatibility date.
3. Configure your OpenAI-compatible client:
   - **Base URL:** `https://<your-worker-host>/v1`
   - **API key:** your **Google API key**, not an OpenAI key.
   - **Model:** a Google model ID available to your key and supported by Interactions, such as `gemma-4-31b-it` where available.
   - **Streaming:** disabled (`stream: false`).

Clients should send JSON via `POST /v1/chat/completions` with `Authorization: Bearer <GOOGLE_API_KEY>`. The Worker removes the bearer prefix and forwards the key as `x-goog-api-key` to:

`https://generativelanguage.googleapis.com/v1/interactions`

The current handler does not enforce a particular path or HTTP method. It attempts to translate every incoming request body. There is no model-list endpoint or CORS/preflight handling.

**Credential handling:** the current implementation uses the caller's bearer token. It does not read `GOOGLE_API_KEY` or `PROXY_API_KEY` Worker secrets, despite the unused `env` import. Only use a Worker operator you trust: that operator can access the submitted key and conversation. Keep keys out of source control, logs, and public browser code.

## Translation behavior

### Requests

- `system` and `developer` messages become a combined `system_instruction`.
- User and assistant history become `user_input` and `model_output` steps.
- Text and `image_url` parts are translated, including base64 image data URLs. Image detail is treated as `auto`.
- Modern `tools`, `tool_choice`, `tool_calls`, and tool results are supported.
- Legacy `functions`, `function_call`, and `role: "function"` messages are normalized into function tools, calls, and results. Modern fields take precedence when supplied.
- Tool results include both the original call ID and the function name recovered from history, with a message-name fallback.
- `temperature`, `top_p`, and `seed` are forwarded in `generation_config`.
- `max_completion_tokens` takes precedence over `max_tokens` and becomes `max_output_tokens`.
- `stop` becomes `stop_sequences`.
- `reasoning_effort` becomes `thinking_level`; unrecognized values are coerced to `medium`.
- Required tool choice becomes `any`; named tool choice becomes an allowed-tools selection.
- `json_object` and `json_schema` response formats become JSON text output configurations. Strict flags are not enforced; unsupported format types fall back to text.

Model-specific support and Google's schema restrictions still apply. Unmapped request options are not forwarded. Unknown message roles are coerced to `user`.

Every upstream request sets `stream: false`, `background: false`, and `store: false`, regardless of client values. Only one completion choice is returned; `n` does not request additional choices.

### Responses

- Model text becomes assistant content; multiple text entries are joined with spaces.
- Function calls become OpenAI-style `tool_calls` with JSON-string arguments.
- Completion IDs use Google's interaction ID when present, otherwise a generated UUID.
- Usage includes input tokens, output plus thought tokens as completion tokens, and cached/reasoning token details when upstream usage exists.
- `finish_reason` is `tool_calls` when calls exist and `stop` otherwise, regardless of upstream status.

## Tool round trips and thought signatures

The client executes tools; this Worker does not execute them.

1. Send the conversation and function declarations.
2. When a response contains `tool_calls`, append the assistant message to history.
3. Execute each function and append a `role: "tool"` message with its result and the exact returned `tool_call_id`.
4. Send the full history again to obtain the next response.

IDs beginning with `gi_` encode the Google call ID and preceding thought blocks as base64url JSON. **Treat these IDs as opaque and replay them unchanged.** They are encoded, not encrypted, and can contain thought summaries and signatures.

On replay, the Worker restores the thought blocks before assistant content and function calls. This ordering matters for thinking models. Legacy calls without IDs receive generated IDs, and legacy results are matched by function name.

There is no stored conversation state or `previous_interaction_id` continuation. Keep the assistant call messages in the history so result names and signatures can be recovered.

## Best-effort behavior and limitations

These behaviors are intentional in the current implementation and matter when interpreting responses:

- `parseTruncatedJSON()` attempts to recover malformed or truncated JSON. Recovery can change values or return incomplete data; it is not schema validation.
- Fetch helpers attempt to preserve partial response bodies after interruptions. A 120-second abort timer bounds upstream fetching/reading, but does not guarantee a complete response.
- HTTP body streams are used internally for reading. There is **no SSE or incremental Chat Completions output**; clients receive one buffered JSON response.
- Upstream HTTP errors are not passed through as HTTP errors. Their bodies can become assistant text in a normal completion response. A `stop` finish reason does **not** prove the model succeeded.
- Model errors and unrecognized output parts/steps are stringified into text. When no text is collected, the entire interaction is stringified into assistant content, including tool-only responses. This can duplicate metadata in replayed history.
- Not every failure is recovered. For example, request translation occurs outside the handler's `try` block. Malformed shapes or invalid encoded tool IDs can still fail.
- Bodies are buffered without an enforced size cap. The declared `bodyLimit` is currently unused; avoid large inputs and outputs.
- This is not a general audio/video adapter, OpenAI Responses API endpoint, or implementation of Google's hosted tools.

## Development

Keep the deployable implementation in `worker.js` and follow `code_style.md`. A local syntax check is `node --check worker.js`; it does not execute Workers-specific imports or verify API behavior.

For runtime testing, use workerd/Miniflare or a deployed Worker. Useful regression cases include modern and legacy tool round trips, thought-block ordering, named function results, missing interaction IDs, truncated JSON, and upstream error bodies. Mocked upstream tests cannot establish live model compatibility.

## References

- [Google Interactions API](https://aistudio.google.com/api-reference/interactions-api)
- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
