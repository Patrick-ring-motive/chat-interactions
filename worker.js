import * as util from 'node:util';

const flattenObject = req => {
  const obj = {};
  for (const key in req) {
    if (typeof req[key] !== 'function') {
      obj[key] = req[key];
    }
  }
  for (const key of Reflect.ownKeys(req)) {
    if (typeof req[key] !== 'function') {
      obj[String(key)] = req[key];
    }
  }
  return obj;
};

const flattenRequest = req => {
  return {
    ...flattenObject(req),
    ...Object.fromEntries(req.headers.entries()),
    ...Object.fromEntries(new URL(req.url).searchParams.entries()),
  };
};

const flattenArray = arr =>{
  return Object.assign({},arr,...arr.map(flattenObject));
};

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

const randId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return String(Math.random()).replace('0.', '');
  }
};

const stringify = (value) => {
  try {
    if (isString(value)) return String(value);
    return String(JSON.stringify(value));
  } catch {
    try {
      return String(value);
    } catch {
      try {
        return util.inspect(value);
      } catch (e) {
        try {
          return String(e);
        } catch {
          return '';
        }
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
    index++;
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
    const flat = stringify(latin1.replaceAll(/\s+/g, " "));
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
          (()=> controller.enqueue(encode(streamError)));
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
    chunks.push(encode(String(e)));
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

const toObj = obj =>{
  if(isString(obj)){
    obj = Object.assign(Object(obj),parseTruncatedJSON(obj));
  }
  if(isArray(obj)){
    return flattenArray(obj);
  }
  return Object(obj);
}

const toArr = arr => {
  if (!isArray(arr)) {
    if (isString(arr)) {
      return [Object.assign(Object(arr), parseTruncatedJSON(arr))];
    }
    if (arr?.[Symbol.iterator]) {
      arr = [...arr].map(Object);
    } else {
      arr = [Object(arr)];
    }
  }
  return arr;
};

function contentParts(content) {
  if (content == null) return [];
  if (isString(content)) return [{
    type: 'text',
    text: content
  }];
  if (!isObject(content)) {
    return [{
      type: 'text',
      text: stringify(content)
    }];
  }
  content = toArr(content);
  return content.map((part) => {
    if (part?.type === 'text') return {
      type: 'text',
      text: firstText(part?.text, part?.content, part?.value) ?? ''
    };
    if (part?.type === 'image_url') {
      const {
        url,
        detail
      } = part?.image_url ?? {};
      (part?.image_url ?? {}).detail &&= 'auto';
      const source = firstText(url, part?.url, part?.uri, isString(part?.image_url) ? part.image_url : undefined);
      const match = imageDataPattern.exec(source);
      if (match) return {
        type: 'image',
        mime_type: match[1],
        data: match[2]
      };
      return source ? {
        type: 'image',
        uri: source
      } : {
        type: 'text',
        text: firstText(part?.text, part?.alt, part?.caption) ?? '[Image unavailable]'
      };
    }
    return {
      type: 'text',
      text: stringify(part)
    };
  });
}
const tryB64 = str => {
  try {
    str = str.replace(/=+$/, '').replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(atob(str.padEnd(Math.ceil(str.length / 4) * 4, '=')), char => char.charCodeAt(0));
  } catch { return encode(str); }
};

const concat = parts => {
  const outputs = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let output = 0;
  for (const part of parts) outputs.set(part, output), output += part.length;
  return outputs;
};

const base64ToBytes = x => instanceOf(x, Uint8Array) ? x :
  concat(stringify(x).split(/([\w+/=-]{4,})/).map((s, i) => i % 2 ? tryB64(s) : encode(s)));


const toThought = thought => {
  thought = toObj(thought);
  const summary = stringify(thought);
  return {
    type: 'thought',
    ...thought,
    ...(thought.summary ? {} : {
      summary: [{
        type: 'text',
        text: summary
      }]
    })
  };
};

function unpackToolId(id) {
  const str = stringify(id).replace(/^gi_/, '');
  const obj1 = parseTruncatedJSON(str);
  const bytes = base64ToBytes(str);
  const obj2 = parseTruncatedJSON(new TextDecoder().decode(bytes).replace(/^gi_/, ''));
  const parsed = {
    ...toObj(obj1),
    ...toObj(obj2)
  };

  return {
    id: parsed?.id ?? str,
    thoughts: toArr(parsed.thoughts ?? parsed).map(toThought)
  }
}

function packToolId(id, thoughts) {
  const bytes = encoder.encode(stringify({
    id,
    thoughts
  }));
  return `gi_${bytes.toBase64({ alphabet: 'base64url', omitPadding: true })}`;
}

function uniqueToolValue(values) {
  const distinct = new Set(values.filter((value) => isString(value) && String(value).length).map(String));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

const defaultModel = 'gemma-4-31b-it';

function firstText(...values) {
  for (const value of values) {
    if (stringify(value ?? '').trim()) return stringify(value);
  }
}

function argumentObject(value) {
  const parsed = isString(value) ? parseTruncatedJSON(value) : value;
  if (parsed == null) return {};
  return isObject(parsed) && !isArray(parsed) ? parsed : {
    value: parsed
  };
}

function generatedName() {
  return `function_${randId().replaceAll('-', '')}`;
}

function translateRequest(body) {
  const input = [];
  const instructions = [];
  const pendingCalls = [];
  const historyCalls = [];
  const tools = toArr(body?.tools ?? body?.functions ?? []).map((tool) => {
    const fn = tool?.function ?? tool ?? {};
    return {
      ...fn,
      name: firstText(fn.name, fn.function_name, fn.title)
    };
  });
  const declaredName = uniqueToolValue(tools.map((tool) => tool.name));
  const messages = body?.messages ?? body?.input ?? body?.prompt ?? body ?? [];
  for (let message of toArr(isString(messages) ? [{
      content: stringify(messages)
    }] : messages)) {
    message = toObj(message);
    if (message.role === 'tool' || message.role === 'function') {
      const suppliedId = uniqueToolValue([unpackToolId(firstText(message.tool_call_id, message.call_id, message.id))?.id]);
      const suppliedName = firstText(message.name, message.function_name, message.function?.name);
      const candidates = pendingCalls.filter((call) =>
        (suppliedId == null || call.id === suppliedId) &&
        (suppliedName == null || call.name == null || call.name === suppliedName));
      const call = candidates.length === 1 ? candidates[0] : undefined;
      const matchingHistory = suppliedId == null ? candidates :
        historyCalls.filter((item) => item.id === suppliedId);
      const name = suppliedName ?? uniqueToolValue(matchingHistory.map((item) => item.name)) ?? declaredName ??
        (call ? generatedName() : undefined);
      if (call) {
        pendingCalls.splice(pendingCalls.indexOf(call), 1);
        call.name ??= name;
      }
      const callId = suppliedId ?? call?.id;
      const result = message.content ?? message.result ?? message.output ?? '';
      if (callId && name) {
        input.push({
          type: 'function_result',
          call_id: callId,
          name,
          result: isString(result) || isObject(result) ? result : stringify(result)
        });
      } else {
        input.push({
          type: 'user_input',
          content: [{
            type: 'text',
            text: stringify({
              ...message,
              result
            })
          }]
        });
      }
      continue;
    }

    let content = toArr(contentParts(message.content ?? message) ?? []);
    const restoredThoughts = [];

    if (message.role === 'assistant') {
      content = content.flatMap((part) => {
        if (part?.type !== 'text' || !isString(part.text)) return [part];

        const output = [];
        const pattern = /\u001eTHOUGHT:([\s\S]*?)\u001f/g;
        let offset = 0;
        let match;

        while ((match = pattern.exec(part.text))) {
          if (match.index > offset) {
            output.push({
              ...part,
              text: part.text.slice(offset, match.index)
            });
          }

          const thought = parseTruncatedJSON(match[1]);
          if (isObject(thought) && !isArray(thought)) {
            const signature = firstText(thought.signature);
            const summary = firstText(thought.text, thought.summary);

            restoredThoughts.push({
              type: 'thought',
              ...(signature ? {
                signature
              } : {}),
              ...(summary ? {
                summary: [{
                  type: 'text',
                  text: summary
                }]
              } : {})
            });
          } else {
            output.push({
              ...part,
              text: match[0]
            });
          }

          offset = pattern.lastIndex;
        }

        if (offset < part.text.length || !output.length) {
          output.push({
            ...part,
            text: part.text.slice(offset)
          });
        }

        return output.filter((item) => item.text !== '');
      });
    }

    if (/^(system|developer)$/.test(message.role)) {
      instructions.push(content.map((part) => part?.text ?? stringify(part)).join('\n'));
      continue;
    }
    if (!/^(user|assistant)$/.test(message.role)) {
      message.role = 'user';
    }

    const calls = toArr(message.tool_calls?.length ? message.tool_calls :
      message.function_call ? [{
        function: message.function_call
      }] : []);
    let pendingContent = content;

    for (const thought of restoredThoughts) {
      input.push(thought);
    }

    for (const call of calls) {
      const fn = call?.function ?? call;
      let {
        id,
        thoughts
      } = toObj(unpackToolId(firstText(call?.id, call?.call_id, call?.tool_call_id)));

      thoughts = toArr(thoughts ?? []);
      input.push(...thoughts);

      if (pendingContent.length) {
        input.push({
          type: 'model_output',
          content: pendingContent
        });
        pendingContent = [];
      }

      const historyName = uniqueToolValue(historyCalls.filter((item) => item.id === id).map((item) => item.name));
      const step = {
        type: 'function_call',
        id: uniqueToolValue([id]) ?? `call_${randId()}`,
        name: firstText(fn?.name, fn?.function_name) ?? historyName ?? declaredName,
        arguments: argumentObject(fn?.arguments ?? fn?.args ?? fn?.parameters)
      };
      input.push(step);
      pendingCalls.push(step);
      historyCalls.push(step);
    }

    if (pendingContent.length) {
      input.push({
        type: message?.role === 'user' ? 'user_input' : 'model_output',
        content: pendingContent
      });
    }
  }

  for (const call of historyCalls) {
    call.name ??= generatedName();
  }

  const generation = {};
  body = toObj(body);

  for (const key of ['temperature', 'top_p', 'seed']) {
    if (body[key] != null) generation[key] = body[key];
  }

  generation.thinking_summaries = body.reasoning_effort ?? 'auto';

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) generation.max_output_tokens = maxTokens;

  if (body.stop != null) {
    generation.stop_sequences = isString(body.stop) ? [body.stop] : toArr(body.stop);
  }

  if (body.reasoning_effort != null) {
    if (!['minimal', 'low', 'medium', 'high'].includes(body.reasoning_effort)) {
      body.reasoning_effort = 'medium';
    }
    generation.thinking_level = body.reasoning_effort;
    generation.thinking_summaries = body.reasoning_effort;
  }

  const choice = body.tool_choice ?? body.function_call;
  if (choice != null) {
    generation.tool_choice = isString(choice) ?
      choice === 'required' ? 'any' : choice : {
        allowed_tools: {
          mode: 'any',
          tools: [choice?.function?.name ?? choice?.name]
        }
      };
  }

  const request = {
    model: firstText(body.model, body.model_id, body.model_name) ?? defaultModel,
    input: input.length ? input : [{
      type: 'user_input',
      content: [{
        type: 'text',
        text: 'Continue.'
      }]
    }],
    stream: false,
    background: false,
    store: false,
    generation_config: generation
  };

  if (instructions.length) request.system_instruction = instructions.join('\n\n');

  if (tools?.length) {
    request.tools = tools.map((tool) => {
      const {
        name,
        description,
        parameters
      } = tool?.function ?? tool ?? {};
      return {
        type: 'function',
        name: uniqueToolValue([name]) ?? (tools.length === 1 ?
          uniqueToolValue(historyCalls.map((call) => call.name)) : undefined) ?? generatedName(),
        description,
        parameters
      };
    });
  }

  if (choice != null && !isString(choice)) {
    const chosenName = firstText(choice?.function?.name, choice?.name) ??
      uniqueToolValue((request.tools ?? []).map((tool) => tool.name));
    generation.tool_choice = chosenName ? {
      allowed_tools: {
        mode: 'any',
        tools: [chosenName]
      }
    } : 'auto';
  }

  const format = body.response_format;
  if (format && format?.type !== 'text') {
    if (!['json_object', 'json_schema'].includes(format.type)) {
      format.type = 'text';
      return request;
    }
    (format?.json_schema ?? {}).strict &&= false;
    request.response_format = {
      type: 'text',
      mime_type: 'application/json',
      schema: format?.json_schema?.schema ?? format?.schema ?? {
        type: 'object'
      }
    };
  }

  return request;
}

function translateResponse(interaction, model, tools = []) {
  const text = [];
  const calls = [];
  let thoughts = [];

  interaction = toObj(interaction);

  for (let step of toArr(interaction.steps ?? interaction)) {
    step = toObj(step);

    if (step.type === 'thought') {
      const signature = firstText(step.signature);
      const summary = toArr(step.summary ?? [])
        .map((part) => firstText(part?.text, part?.content, part?.value))
        .filter(Boolean)
        .join('\n');

      thoughts.push(step);

      text.push(
        `\u001eTHOUGHT:${stringify({
          ...(signature ? {
            signature
          } : {}),
          ...(summary ? {
            text: summary
          } : {})
        })}\u001f`
      );

    } else if (step.type === 'model_output') {
      if (step.error) {
        text.push(stringify(step.error));
        continue;
      }

      for (const part of toArr(step?.content ?? step)) {
        text.push(firstText(part?.text, part?.content, part?.value) ?? stringify(part));
      }

    } else if (step.type === 'function_call') {
      calls.push({
        id: firstText(step.id, step.call_id) ?? `call_${randId()}`,
        type: 'function',
        function: {
          name: firstText(step.name, step.function_name, step.function?.name) ??
            uniqueToolValue(toArr(interaction.tools ?? tools).map((tool) => (tool?.function ?? tool)?.name)) ??
            generatedName(),
          arguments: stringify(argumentObject(step.arguments ?? step.args ?? step.function?.arguments ?? step))
        }
      });

      thoughts = [];

    } else {
      text.push(stringify(step));
    }
  }

  const message = {
    role: 'assistant',
    content: text.length ? text.join('') : ''
  };

  if (calls.length) message.tool_calls = calls;

  const result = {
    id: `chatcmpl-${firstText(interaction.id, interaction.interaction_id) ?? randId()}`,
    object: 'chat.completion',
    created: Math.floor((Date.parse(firstText(interaction.created, interaction.updated)) || Date.now()) / 1000),
    model: firstText(interaction.model, model) ?? defaultModel,
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = translateRequest(request.body ? await readJson(request) : flattenRequest(request));

      const upstream = await fetchResponse(interactionsUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-goog-api-key': String(request.headers.get('authorization')).replace(/Bearer\s+/i, '')
        },
        body: stringify(payload)
      });
      const interaction = await readJson(upstream);
      return Response.json(translateResponse(interaction, payload.model, payload.tools), {
        headers: {
          'Cache-Control': 'no-store'
        },
        status: stringify(interaction).includes('Rate limit exceeded') ? 429 : upstream.status
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
