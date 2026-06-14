import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, ComputerUseResponse } from './types.js';
export type { ContentBlock, ComputerUseResponse } from './types.js';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'eu-central-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const MODEL_ID = process.env.BEDROCK_MODEL || 'eu.anthropic.claude-sonnet-4-6';

/**
 * Send screenshot + task to Claude via Bedrock EU (Computer Use)
 * Data stays in eu-central-1 (Frankfurt) — DSGVO compliant
 */
export async function computerUseCall(
  messages: Array<{ role: string; content: any[] }>,
  systemPrompt?: string,
): Promise<ComputerUseResponse> {
  const bedrockMessages = messages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content.map((block: any) => {
      if (block.type === 'image') {
        // Bedrock expects Uint8Array, not base64 string
        const imageBytes = typeof block.source.data === 'string' 
          ? Buffer.from(block.source.data, 'base64')
          : block.source.data;
        return {
          image: {
            format: 'png' as const,
            source: { bytes: imageBytes },
          },
        };
      }
      if (block.type === 'text') {
        return { text: block.text };
      }
      if (block.type === 'tool_use') {
        return {
          toolUse: {
            toolUseId: block.id,
            name: block.name,
            input: block.input || {},
          },
        };
      }
      if (block.type === 'tool_result') {
        return {
          toolResult: {
            toolUseId: block.tool_use_id,
            content: block.content?.map((c: any) => {
              if (c.type === 'image') {
                const imgBytes = typeof c.source.data === 'string' ? Buffer.from(c.source.data, 'base64') : c.source.data;
                return { image: { format: 'png' as const, source: { bytes: imgBytes } } };
              }
              return { text: c.text || JSON.stringify(c) };
            }) || [{ text: 'done' }],
          },
        };
      }
      return { text: JSON.stringify(block) };
    }),
  }));

  const response = await client.send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: bedrockMessages,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    toolConfig: {
      tools: [{
        toolSpec: {
          name: 'computer_use_placeholder',
          description: 'Placeholder for Bedrock toolConfig requirement',
          inputSchema: { json: { type: 'object', properties: {} } },
        },
      }],
    },
    additionalModelRequestFields: {
      tools: [
        {
          type: 'computer_20251124',
          name: 'computer',
          display_height_px: Number(process.env.SCREENSHOT_HEIGHT) || 768,
          display_width_px: Number(process.env.SCREENSHOT_WIDTH) || 1024,
          display_number: 0,
        },
        { type: 'bash_20250124', name: 'bash' },
      ],
      anthropic_beta: ['computer-use-2025-11-24'],
    },
  }));

  const content: ContentBlock[] = [];
  for (const block of response.output?.message?.content || []) {
    if ('text' in block && block.text) {
      content.push({ type: 'text', text: block.text });
    }
    if ('toolUse' in block && block.toolUse) {
      content.push({
        type: 'tool_use',
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: block.toolUse.input as Record<string, any>,
      });
    }
  }

  return {
    stopReason: response.stopReason || 'end_turn',
    content,
    usage: {
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
    },
  };
}
