/**
 * Provider-agnostic LLM response shape used by the agent loops.
 * Both the Bedrock and the direct-Anthropic provider return this.
 */
export interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
}

export interface ComputerUseResponse {
  stopReason: string;
  content: ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
}

/** A single message in the agent loop. content is already in native Anthropic block format. */
export interface LlmMessage {
  role: string;
  content: any[];
}
