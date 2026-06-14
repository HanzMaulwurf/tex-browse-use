import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, ComputerUseResponse, LlmMessage } from './types.js';

/**
 * Direct Anthropic Messages API provider (Computer Use beta).
 *
 * Drop-in alternative to the Bedrock provider for local/dev use: set
 * ANTHROPIC_API_KEY (and optionally LLM_PROVIDER=anthropic) and the engine
 * talks straight to the Anthropic API — no AWS account needed.
 *
 * The agent loops already build messages in native Anthropic block format
 * (text / image{source.base64} / tool_use / tool_result), so messages pass
 * through unchanged; we only attach the computer-use tool + beta header.
 */
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096;
// Computer Use tool/beta versions — verified against the Anthropic docs.
// computer-use-2025-11-24 covers Opus 4.5/4.6/4.7/4.8 and Sonnet 4.6.
const COMPUTER_USE_BETA = process.env.ANTHROPIC_COMPUTER_USE_BETA || 'computer-use-2025-11-24';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // ANTHROPIC_BASE_URL is honoured automatically by the SDK if set.
});

export async function computerUseCall(
  messages: LlmMessage[],
  systemPrompt?: string,
): Promise<ComputerUseResponse> {
  const width = Number(process.env.SCREENSHOT_WIDTH) || 1024;
  const height = Number(process.env.SCREENSHOT_HEIGHT) || 768;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    tools: [
      {
        type: 'computer_20251124',
        name: 'computer',
        display_width_px: width,
        display_height_px: height,
        display_number: 1,
      } as any,
      { type: 'bash_20250124', name: 'bash' } as any,
    ],
    // messages are already native Anthropic content blocks
    messages: messages as any,
    betas: [COMPUTER_USE_BETA],
  });

  const content: ContentBlock[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, any>,
      });
    }
  }

  return {
    stopReason: response.stop_reason || 'end_turn',
    content,
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}
