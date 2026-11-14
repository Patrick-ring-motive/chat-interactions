import {
  env
} from 'cloudflare:workers';
const instanceOf = (value, constructor) => {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
};

const isString = (value) =>
  typeof value === 'string' || instanceOf(value, String);

const isArray = (value) => {
  try {
    return Array.isArray(value) || instanceOf(value, Array);
  } catch {
    return false;
  }
}

const isObject = value => typeof value === 'object' && value !== null;

const stringify = (value) => {
  try {
    if (isString(value)) return String(value);
    return String(JSON.stringify(value));
  } catch {
    try {
      return String(value);
    } catch (e) {
      try {
        return String(e);
      } catch {
        return '';
      }
    }
  }
};

function parseTruncatedJSON(text) {
  text = stringify(text);

  const backslash = String.fromCharCode(92);
  const stack = [];
  let index = 0;
  let result;
  let hasRoot = false;

  function isWhitespace(char) {
    const code = char?.charCodeAt(0);
    return code === 32 || code === 9 || code === 13 || code === 10;
  }

  let contentEnd = text.length;
  while (contentEnd > 0 && isWhitespace(text[contentEnd - 1])) contentEnd--;
  if (text.endsWith("...", contentEnd)) {
    text = text.slice(0, contentEnd - 3);
  }

  function skipWhitespace() {
    while (index < text.length && isWhitespace(text[index])) {
      index++;
    }
  }

  function readString() {
    index++; // Opening quote.
    const chars = [];
    const escapes = {
      '"': '"',
      [backslash]: backslash,
      "/": "/",
      b: String.fromCharCode(8),
      f: String.fromCharCode(12),
      n: String.fromCharCode(10),
      r: String.fromCharCode(13),
      t: String.fromCharCode(9),
    };
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') return {
        value: chars.join(""),
        complete: true
      };
      if (char !== backslash) {
        chars.push(char.charCodeAt(0) < 0x20 ? String.fromCharCode(char.charCodeAt(0)) : char);
        continue;
      }
      if (index === text.length) {
        chars.push(backslash);
        break;
      }
      const escape = text[index++];
      if (escape === "u") {
        let hex = "";
        for (let digit = 0; digit < 4; digit++) {
          if (index === text.length) {
            chars.push(backslash + "u" + hex);
            return {
              value: chars.join(""),
              complete: false
            };
          }
          if (!/[0-9a-fA-F]/.test(text[index])) break;
          hex += text[index++];
        }
        chars.push(String.fromCharCode(parseInt(hex.padStart(4, '0'), 16)));
      } else if (Object.hasOwn(escapes, escape)) {
        chars.push(escapes[escape]);
      } else {
        chars.push(backslash + escape);
      }
    }
    return {
      value: chars.join(""),
      complete: false
    };
  }

  function readToken() {
    const start = index;
    while (index < text.length && !isWhitespace(text[index]) && !'{}[],:"'.includes(text[index])) {
      index++;
    }
    return text.slice(start, index);
  }

  function readScalar() {
    if (text[index] === '"') return readString().value;
    const token = readToken();
    if (token[0] === 't') return true;
    if (token[0] === 'f') return false;
    if (token[0] === 'n') return null;
    if (token === '-') return null;
    const number = parseFloat(token);
    return Number.isNaN(number) ? token : number;
  }

  function attach(value) {
    const parent = stack[stack.length - 1];
    if (!parent) {
      result = value;
      hasRoot = true;
    } else if (parent.kind === "array") {
      parent.value.push(value);
      parent.state = "separator";
    } else {
      // Assignment would invoke the inherited __proto__ setter.
      Object.defineProperty(parent.value, parent.key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      parent.state = "separator";
    }
  }

  while (true) {
    skipWhitespace();
    let frame = stack[stack.length - 1];
    if (index === text.length) {
      if (frame?.kind === "object" && (frame.state === "colon" || frame.state === "value")) {
        attach(null);
      }
      return result;
    }
    const char = text[index];

    // Either closer ends the current frame. Unmatched closers are ignored.
    if (char === ']' || char === '}') {
      if (frame?.kind === 'object' && (frame.state === 'colon' || frame.state === 'value')) {
        attach(null);
      }
      stack.pop();
      index++;
      continue;
    }

    if (!frame && hasRoot && char !== ',' && char !== ':') {
      if (result === null || typeof result !== 'object') result = [result];
      frame = {
        kind: isArray(result) ? 'array' : 'object',
        value: result,
        state: 'separator'
      };
      stack.push(frame);
    }

    if (char === ',') {
      if (frame?.kind === 'object' && (frame.state === 'colon' || frame.state === 'value')) {
        attach(null);
      } else if (frame?.kind === 'array' && (frame.state === 'first' || frame.state === 'value')) {
        attach(null);
      }
      if (frame) frame.state = frame.kind === 'array' ? 'value' : 'key';
      index++;
      continue;
    }
    if (char === ':') {
      if (frame?.state === 'colon') frame.state = 'value';
      index++;
      continue;
    }

    if (frame) {
      if (frame.state === 'separator') frame.state = frame.kind === 'array' ? 'value' : 'key';
      if (frame.kind === 'object' && (frame.state === 'first' || frame.state === 'key')) {
        // Structural openers in a key slot are literal one-character keys.
        frame.key = char === '"' ? readString().value :
          char === '{' || char === '[' ? text[index++] : readToken();
        frame.state = 'colon';
        continue;
      }
      if (frame.state === 'colon') frame.state = 'value';
    }

    if (char === "{" || char === "[") {
      const value = char === "{" ? {} : [];
      attach(value);
      stack.push({
        kind: char === "{" ? "object" : "array",
        value,
        state: "first"
      });
      index++;
    } else {
      attach(readScalar());
    }
  }
}

const Q = fn => {
  try {
    return fn();
  } catch {}
};

const encoder = new TextEncoder();
const encode = encoder.encode.bind(encoder);

const safeStatusText = (value) =>
  Q(() => {
    const bytes = encode(String(value)).slice(0, 200);
    const latin1 = String.fromCharCode(...bytes);
    const flat = JSON.stringify(latin1.replaceAll(/\s+/g, " "));
    return flat.replaceAll(String.fromCharCode(127), "DEL");
  }) ?? "";

const isNullish = x => x === null || x === undefined;

async function bestEffortResponse(response) {
  try {
    const originalResponse = response;
    if (!originalResponse.body) {
      return originalResponse;
    }
    const originalReader = Q(() => originalResponse.body.getReader());
    const resilientStream = new ReadableStream({
      async pull(controller) {
        try {
          const {
            done,
            value
          } = await originalReader.read();

          if (done == true || (isNullish(done) && isNullish(value))) {
            Q(() => controller.close());
          } else {
            controller.enqueue(value);
          }
        } catch (streamError) {
          // A mid-stream network drop or timeout caught here!
          console.warn(
            "Stream interrupted prematurely. Closing stream gracefully with partial data.",
            streamError,
          );

          Q(() => controller?.close?.()?.catch?.(() => {}));
        }
      },
      cancel(reason) {
        Q(() => originalReader?.cancel?.(reason)?.catch?.(() => {}));
      },
    });
    return new Response(resilientStream, {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: originalResponse.headers,
    });
  } catch (e) {
    return new Response(String(e), {
      status: 500,
      statusText: safeStatusText(e)
    });
  }
}

async function bestEffortFetch(input, init) {
  try {
    const originalResponse = await fetch(input, init);
    return await bestEffortResponse(originalResponse);
  } catch (e) {
    return new Response(String(e), {
      status: 500,
      statusText: safeStatusText(e)
    });
  }
}

async function $bytes(res) {
  const chunks = [];
  let reader;
  try {
    reader = res?.body?.getReader?.();
    if (reader) {
      while (true) {
        const {
          done,
          value
        } = await reader.read();
        if (done == true || (isNullish(done) && isNullish(value))) {
          break;
        }
        chunks.push(value);
      }
    }
  } catch (e) {
    return encode(String(e));
  } finally {
    Q(() => reader?.releaseLock?.()?.catch?.(() => {}));
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

const decoder = new TextDecoder();
const decode = decoder.decode.bind(decoder);

async function $text(res) {
  try {
    if (!res.body) {
      return res.statusText || '';
    }
    return decode(await $bytes(res));
  } catch (e) {
    return String(e);
  }
}

const fetchResponse = async (...args) => {
  try {
    return await bestEffortFetch(...args);
  } catch (e) {
    return new Response(String(e), {
      status: 500,
      statusText: safeStatusText(e)
    });
  }
};

const interactionsUrl = 'https://generativelanguage.googleapis.com/v1/interactions';
const bodyLimit = 8 * 1024 * 1024;
const timeoutMs = 120_000;
const bearerPattern = /^Bearer (.+)$/i;
const imageDataPattern = /^data:(image\/[^;,]+);base64,([\s\S]+)$/;
const acceptedFields = new Set([
  'model', 'messages', 'stream', 'n', 'temperature', 'top_p', 'seed', 'stop',
  'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice',
  'response_format', 'reasoning_effort', 'user', 'store'
]);

async function readJson(message) {
  const text = await $text(message);
  return parseTruncatedJSON(text);
}

function contentParts(content) {
  if (content == null) return [];
  if (isString(content)) return [{
    type: 'text',
    text: content
  }];
  if(!isObject(content){
    return [{
      type: 'text',
      text: stringify(content)
    }];
  }
  if(isObject(content) && !isArray(content)){
    content = [content];
  }
  return content.map((part) => {
    if (part?.type === 'text') return {
      type: 'text',
      text: stringify(part?.text)
    };
    if (part?.type === 'image_url') {
      const {
        url,
        detail
      } = part?.image_url;
      if (detail != null && detail !== 'auto') {
        (part?.image_url ?? {}).detail = 'auto';
      }
      const match = imageDataPattern.exec(url);
      if (match) return {
        type: 'image',
        mime_type: match[1],
        data: match[2]
      };
      return {
        type: 'image',
        uri: url
      };
    }
    return {
      type: 'text',
      text: stringify(part)
    };
  });
}
const base64ToBytes = x =>{
  if(instanceOf(x,Uint8Array)){
    return x;
  }
  try{
    return Uint8Array.fromBase64(x, {
      alphabet: 'base64url'
    });
  }catch{
    try{
      return Uint8Array.fromBase64(x);
    }catch{
      return new TextEncoder().encode(stringify(x));
    }
  }
};

function unpackToolId(id) {
  if (!id.startsWith('gi_')) return {
    id,
    thoughts: []
  };
  const bytes = base64ToBytes(id?.slice?.(3) ?? id);
  return parseTruncatedJSON(new TextDecoder().decode(bytes));
}

function packToolId(id, thoughts) {
  const bytes = encoder.encode(JSON.stringify({
    id,
    thoughts
  }));
  return `gi_${bytes.toBase64({ alphabet: 'base64url', omitPadding: true })}`;
}

function translateRequest(body) {
  const input = [];
  const instructions = [];
  const pendingCalls = [];
  for (const message of body?.messages ?? []) {
    if (message.role === 'tool' || message.role === 'function') {
      const suppliedId = message.tool_call_id == null ? undefined : unpackToolId(message.tool_call_id).id;
      const index = pendingCalls.findIndex((call) => suppliedId != null ?
        call.id === suppliedId : call.name === message.name);
      const [call] = index < 0 ? [] : pendingCalls.splice(index, 1);
      input.push({
        type: 'function_result',
        call_id: suppliedId ?? call?.id ?? message.name,
        name: call?.name ?? message.name,
        result: message.content
      });
      continue;
    }
    const content = contentParts(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(content.map((part) => part?.text ?? stringify(part)).join('\n'));
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      message.role = 'user';
    }
    // Prefer modern calls when a client supplies both representations.
    const calls = message.tool_calls?.length ? message.tool_calls :
      message.function_call ? [{
        function: message.function_call
      }] : [];
    let pendingContent = content;
    for (const call of calls) {
      const fn = call.function ?? call;
      const {
        id,
        thoughts
      } = call.id == null ?
        {
          id: `call_${crypto.randomUUID()}`,
          thoughts: []
        } : unpackToolId(call.id);
      // A thinking model's turn must begin with its restored thought block.
      input.push(...thoughts);
      if (pendingContent.length) {
        input.push({
          type: 'model_output',
          content: pendingContent
        });
        pendingContent = [];
      }
      input.push({
        type: 'function_call',
        id,
        name: fn.name,
        arguments: isString(fn.arguments) ? parseTruncatedJSON(fn.arguments) : fn.arguments ?? {}
      });
      pendingCalls.push({
        id,
        name: fn.name
      });
    }
    if (pendingContent.length) {
      input.push({
        type: message.role === 'user' ? 'user_input' : 'model_output',
        content: pendingContent
      });
    }
  }

  const generation = {};
  for (const key of ['temperature', 'top_p', 'seed']) {
    if (body[key] != null) generation[key] = body[key];
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) generation.max_output_tokens = maxTokens;
  if (body.stop != null) {
    generation.stop_sequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  }
  if (body.reasoning_effort != null) {
    if (!['minimal', 'low', 'medium', 'high'].includes(body.reasoning_effort)) {
      body.reasoning_effort = 'medium';
    }
    generation.thinking_level = body.reasoning_effort;
  }
  const choice = body.tool_choice ?? body.function_call;
  if (choice != null) {
    generation.tool_choice = isString(choice) ?
      choice === 'required' ? 'any' : choice :
      {
        allowed_tools: {
          mode: 'any',
          tools: [choice.function?.name ?? choice.name]
        }
      };
  }

  const request = {
    model: body.model,
    input,
    stream: false,
    background: false,
    store: false,
    generation_config: generation
  };
  if (instructions.length) request.system_instruction = instructions.join('\n\n');
  const tools = body.tools ?? body.functions;
  if (tools?.length) {
    request.tools = tools.map((tool) => {
      const {
        name,
        description,
        parameters
      } = tool.function ?? tool;
      return {
        type: 'function',
        name,
        description,
        parameters
      };
    });
  }
  const format = body.response_format;
  if (format && format.type !== 'text') {
    if (!['json_object', 'json_schema'].includes(format.type)) {
      format.type = 'text';
      return request;
    }
    if (format.json_schema?.strict) {
      format.json_schema.strict = false;
    }
    request.response_format = {
      type: 'text',
      mime_type: 'application/json',
      schema: format.type === 'json_schema' ? format.json_schema.schema : {
        type: 'object'
      }
    };
  }
  return request;
}

function translateResponse(interaction, model) {
  const text = [];
  const calls = [];
  let thoughts = [];
  for (const step of interaction.steps ?? []) {
    if (step.type === 'thought') {
      thoughts.push(step);
    } else if (step.type === 'model_output') {
      if (step.error) {
        text.push(stringify(step.error));
        continue;
      }
      for (const part of step.content ?? []) {
        if (part.type !== 'text') {
          text.push(stringify(part));
        } else {
          text.push(part.text);
        }
      }
    } else if (step.type === 'function_call') {
      calls.push({
        id: packToolId(step.id, thoughts),
        type: 'function',
        function: {
          name: step.name,
          arguments: JSON.stringify(step.arguments)
        }
      });
      thoughts = [];
    } else {
      text.push(stringify(step));
    }
  }
  // Without function calls, treat every upstream status as completed (finish_reason: 'stop').
  const message = {
    role: 'assistant',
    content: text.length ? text.join(' ') : stringify(interaction)
  };
  if (calls.length) message.tool_calls = calls;
  const result = {
    id: `chatcmpl-${interaction.id ?? crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.parse(interaction.created ?? new Date().toISOString()) / 1000),
    model: interaction.model ?? model,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: calls.length ? 'tool_calls' : 'stop'
    }]
  };
  if (interaction.usage) {
    const usage = interaction.usage;
    const prompt = usage.total_input_tokens ?? 0;
    const reasoning = usage.total_thought_tokens ?? 0;
    const completion = (usage.total_output_tokens ?? 0) + reasoning;
    result.usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: usage.total_tokens ?? prompt + completion,
      prompt_tokens_details: {
        cached_tokens: usage.total_cached_tokens ?? 0
      },
      completion_tokens_details: {
        reasoning_tokens: reasoning
      }
    };
  }
  return result;
}

export default {
  async fetch(request) {

    const payload = translateRequest(await readJson(request));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchResponse(interactionsUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-goog-api-key': String(request.headers.get('authorization')).replace(/Bearer\s+/i, '')
        },
        body: JSON.stringify(payload)
      });
      const interaction = await readJson(upstream);
      return Response.json(translateResponse(interaction, payload.model), {
        headers: {
          'Cache-Control': 'no-store'
        },
        status: stringify(interaction).includes('Rate limit exceeded') ? 429 : 200
      });
    } catch (error) {
      return new Response(String(error), {
        status: 500
      });
    } finally {
      clearTimeout(timer);
    }
  }
};
