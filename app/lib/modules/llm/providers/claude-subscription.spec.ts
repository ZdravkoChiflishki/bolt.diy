import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/modules/llm/manager', () => ({
  LLMManager: {
    getInstance: () => ({ env: {} }),
  },
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((options) => {
    const provider = (modelId: string) => ({
      modelId,
      options,
      doGenerate: vi
        .fn()
        .mockResolvedValue({ text: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' }),
      doStream: vi.fn(),
    });
    return provider;
  }),
}));

async function createProvider() {
  const { default: providerCtor } = await import('./claude-subscription');

  return new providerCtor();
}

describe('ClaudeSubscriptionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('describes a direct Claude Code subscription provider', async () => {
    const provider = await createProvider();

    expect(provider.name).toBe('ClaudeSubscription');
    expect(provider.config.apiTokenKey).toBe('CLAUDE_CODE_ACCESS_TOKEN');
    expect(provider.staticModels).toContainEqual({
      name: 'claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5 (Claude Subscription)',
      provider: 'ClaudeSubscription',
      maxTokenAllowed: 200000,
      maxCompletionTokens: 8192,
    });
  });

  it('fetches dynamic models from Anthropic with Claude OAuth bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            type: 'model',
            id: 'claude-sonnet-4-5',
            display_name: 'Claude Sonnet 4.5',
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
          {
            type: 'model',
            id: 'claude-opus-5',
            display_name: 'Claude Opus 5',
            max_input_tokens: 1000000,
            max_tokens: 128000,
          },
          { type: 'not-model', id: 'ignored' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await createProvider();
    const models = await provider.getDynamicModels({ ClaudeSubscription: 'claude-oauth-token' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer claude-oauth-token',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    expect(models.map((model) => model.name)).toEqual(['claude-sonnet-4-5', 'claude-opus-5']);
  });

  it('creates an Anthropic model client that strips x-api-key and sends bearer auth', async () => {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const provider = await createProvider();
    const model = provider.getModelInstance({
      model: 'claude-sonnet-4-5',
      apiKeys: { ClaudeSubscription: 'claude-oauth-token' },
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'say ok' }] }],
      mode: { type: 'regular' },
    } as any);

    expect(result.text).toBe('ok');
    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'oauth-placeholder',
        headers: expect.objectContaining({
          Authorization: 'Bearer claude-oauth-token',
          'anthropic-beta': 'output-128k-2025-02-19',
        }),
        fetch: expect.any(Function),
      }),
    );

    const { withoutApiKeyHeader } = await import('./claude-subscription');
    const forwardedFetch = vi.fn().mockResolvedValue('ok');
    const oauthFetch = withoutApiKeyHeader(forwardedFetch as any);

    await oauthFetch('https://api.anthropic.com/v1/messages', {
      headers: {
        'x-api-key': 'oauth-placeholder',
        Authorization: 'Bearer claude-oauth-token',
      },
    });

    const forwardedHeaders = forwardedFetch.mock.calls[0][1].headers as Headers;
    expect(forwardedHeaders.get('x-api-key')).toBeNull();
    expect(forwardedHeaders.get('Authorization')).toBe('Bearer claude-oauth-token');
  });
});
