import { describe, expect, it } from 'vitest';
import {
  buildCodexRequestUsageAnnotation,
  buildCodexResponseUsageAnnotation,
  estimateTokensFromText,
  isChatGPTSubscriptionProvider,
} from './codex-usage-monitor';

describe('codex usage monitor', () => {
  it('only enables subscription monitoring for the ChatGPTSubscription provider', () => {
    expect(isChatGPTSubscriptionProvider('ChatGPTSubscription')).toBe(true);
    expect(isChatGPTSubscriptionProvider('OpenAI')).toBe(false);
    expect(isChatGPTSubscriptionProvider('OpenRouter')).toBe(false);
  });

  it('estimates context size without creating any max token limit', () => {
    expect(estimateTokensFromText('abcd '.repeat(20))).toBeGreaterThan(0);

    const annotation = buildCodexRequestUsageAnnotation({
      provider: 'ChatGPTSubscription',
      model: 'gpt-5.5',
      messageText: 'hello world '.repeat(100),
      contextFiles: {
        '/app/index.ts': { content: 'const x = 1;'.repeat(100), type: 'file' } as any,
      },
    });

    expect(annotation.type).toBe('codexUsage');
    expect(annotation.value.phase).toBe('request');
    expect(annotation.value.provider).toBe('ChatGPTSubscription');
    expect(annotation.value.model).toBe('gpt-5.5');
    expect(annotation.value.estimatedPromptTokens).toBeGreaterThan(0);
    expect(annotation.value).not.toHaveProperty('maxTokens');
    expect(annotation.value).not.toHaveProperty('maxCompletionTokens');
  });

  it('records actual Codex usage returned by the provider', () => {
    const annotation = buildCodexResponseUsageAnnotation({
      provider: 'ChatGPTSubscription',
      model: 'gpt-5.5',
      usage: {
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
      },
    });

    expect(annotation).toEqual({
      type: 'codexUsage',
      value: {
        provider: 'ChatGPTSubscription',
        model: 'gpt-5.5',
        phase: 'response',
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        warningLevel: 'info',
        message: 'ChatGPT/Codex subscription usage: 1,500 tokens (prompt: 1,200, completion: 300).',
      },
    });
  });
});
