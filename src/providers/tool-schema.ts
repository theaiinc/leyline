/**
 * Tool JSON schemas as some providers accept them. Coding agents' tools carry regex `pattern` constraints with
 * lookaround (e.g. an email pattern), which some OpenAI-compatible gateways reject outright ("regex lookaround is not
 * supported"). A pattern only narrows what the model may write, so dropping the unsupported ones is harmless.
 */
const LOOKAROUND = /\(\?(?:=|!|<=|<!)/;

export function stripUnsupportedPatterns<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedPatterns) as unknown as T;
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    // `pattern` as a keyword (a string); a property that happens to be named "pattern" is an object and is kept.
    if (key === 'pattern' && typeof value === 'string' && LOOKAROUND.test(value)) continue;
    out[key] = stripUnsupportedPatterns(value);
  }
  return out as T;
}

/** The same, for an OpenAI `tools` array (function parameters). */
export function sanitizeToolSchemas(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    const fn = (tool as { function?: { parameters?: unknown } })?.function;
    return fn?.parameters ? { ...tool, function: { ...fn, parameters: stripUnsupportedPatterns(fn.parameters) } } : tool;
  });
}
