import type { ContentBlock, ComputerUseResponse, LlmMessage } from './types.js';
export type { ContentBlock, ComputerUseResponse, LlmMessage } from './types.js';

/**
 * LLM provider selector.
 *
 *   LLM_PROVIDER=anthropic   → direct Anthropic Messages API (needs ANTHROPIC_API_KEY)
 *   LLM_PROVIDER=bedrock     → AWS Bedrock EU (needs AWS_* creds)
 *
 * If LLM_PROVIDER is unset, auto-detect: ANTHROPIC_API_KEY present → anthropic,
 * otherwise → bedrock. Providers are imported lazily so you only need the SDK
 * (and credentials) for the provider you actually use.
 */
function selectProvider(): 'anthropic' | 'bedrock' {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'bedrock') return explicit;
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'bedrock';
}

export async function computerUseCall(
  messages: LlmMessage[],
  systemPrompt?: string,
): Promise<ComputerUseResponse> {
  if (selectProvider() === 'anthropic') {
    const mod = await import('./anthropic.js');
    return mod.computerUseCall(messages, systemPrompt);
  }
  const mod = await import('./bedrock-eu.js');
  return mod.computerUseCall(messages, systemPrompt);
}
