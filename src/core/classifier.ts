import { ClassifyRequest, RouterClassification } from './types';

/**
 * The router classifier prompt — tells the model what to output.
 *
 * Leyline owns the prompt and parser so routing semantics are consistent
 * across all consumers.  The actual LLM call is provided externally via
 * the `ClassifyFn` dependency.
 */
export const ROUTER_PROMPT = `\
You classify user requests.

Output EXACTLY 3 lines (no extra text):

COMPLEXITY: simple | medium | complex
DOMAIN: chat | coding | planning | workflow | memory | extraction
REASONING: true | false

Definitions:
simple — retrieval, factual questions, extraction, summarization, casual conversation.
medium — code generation, SQL, transformations, drafting, moderate analysis.
complex — debugging, architecture, multi-step planning, workflow design, root-cause analysis.
REASONING=true when the request requires deliberate planning, evaluation of alternatives, debugging, or causal analysis.`;

/**
 * Function signature for the external LLM call.
 *
 * Consumers wire their own LLM endpoint (LM Studio, Ollama, OpenAI, etc.)
 * so leyline stays provider-agnostic.
 *
 * @param system - the system prompt (ROUTER_PROMPT)
 * @param userMessage - the assembled user context
 * @returns the raw text response from the LLM
 */
export type ClassifyFn = (system: string, userMessage: string) => Promise<string>;

/**
 * Classifier — routes a user message through a lightweight LLM
 * and returns a structured classification (complexity, domain, reasoning).
 *
 * The actual LLM call is provided externally so the consumer controls
 * which model/endpoint to use for routing.
 */
export class Classifier {
  private classifyFn: ClassifyFn;

  constructor(classifyFn: ClassifyFn) {
    this.classifyFn = classifyFn;
  }

  /** Replace the classify function at runtime (e.g. when router model changes). */
  setClassifyFn(fn: ClassifyFn) {
    this.classifyFn = fn;
  }

  /**
   * Classify a user message and return a structured RouterClassification.
   * On failure (LLM error, parse error) returns a safe fallback:
   *   { complexity: 'simple', domain: 'chat', reasoning: false }
   */
  async classifyRequest(request: ClassifyRequest): Promise<RouterClassification> {
    const contextParts: string[] = [request.userMessage];
    if (request.chatHistory) {
      const recent = request.chatHistory.slice(-4);
      for (const m of recent) {
        const role = (m.role || '?').toUpperCase();
        const content = (m.content || '').slice(0, 200);
        contextParts.push(`${role}: ${content}`);
      }
    }
    const combined = contextParts.join('\n\n');

    try {
      const raw = await this.classifyFn(ROUTER_PROMPT, combined);
      return this._parseOutput(raw);
    } catch {
      // Safe fallback — route as simple chat (cheapest tier)
      return { complexity: 'simple', domain: 'chat', reasoning: false };
    }
  }

  /** Parse the 3-line structured router output. */
  private _parseOutput(raw: string): RouterClassification {
    const result: RouterClassification = { complexity: 'simple', domain: 'chat', reasoning: false };

    for (const line of (raw || '').split('\n')) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim().toUpperCase();
      const val = trimmed.slice(colonIdx + 1).trim().toLowerCase();

      if (key === 'COMPLEXITY' && ['simple', 'medium', 'complex'].includes(val)) {
        result.complexity = val as 'simple' | 'medium' | 'complex';
      } else if (
        key === 'DOMAIN' &&
        ['chat', 'coding', 'planning', 'workflow', 'memory', 'extraction'].includes(val)
      ) {
        result.domain = val as 'chat' | 'coding' | 'planning' | 'workflow' | 'memory' | 'extraction';
      } else if (key === 'REASONING' && (val === 'true' || val === 'false')) {
        result.reasoning = val === 'true';
      }
    }

    return result;
  }
}
