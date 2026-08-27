import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/modules/llm/manager', () => ({
  LLMManager: {
    getInstance: () => ({ env: {} }),
  },
}));

async function createProvider() {
  const { default: providerCtor } = await import('./chatgpt-subscription');

  return new providerCtor();
}

describe('ChatGPTSubscriptionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('describes a direct ChatGPT Codex subscription provider', async () => {
    const provider = await createProvider();

    expect(provider.name).toBe('ChatGPTSubscription');
    expect(provider.config.apiTokenKey).toBe('CHATGPT_CODEX_ACCESS_TOKEN');
    expect(provider.staticModels).toContainEqual({
      name: 'gpt-5.5',
      label: 'gpt-5.5 (ChatGPT Subscription)',
      provider: 'ChatGPTSubscription',
      maxTokenAllowed: 272000,
      maxCompletionTokens: 128000,
    });
  });

  it('fetches dynamic models directly from the ChatGPT Codex backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { slug: 'gpt-5.5', priority: 1 },
          { slug: 'hidden-model', visibility: 'hide', priority: 2 },
          { slug: 'gpt-5.3-codex-spark', priority: 3 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await createProvider();
    const models = await provider.getDynamicModels({ ChatGPTSubscription: 'test.jwt.token' }, undefined, {
      CHATGPT_CODEX_ACCOUNT_ID: 'acct_test',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test.jwt.token',
          originator: 'codex_cli_rs',
          'ChatGPT-Account-ID': 'acct_test',
        }),
      }),
    );
    expect(models.map((model) => model.name)).toEqual(['gpt-5.5', 'gpt-5.3-codex-spark']);
  });

  it('returns a LanguageModelV1 that posts Responses API requests without a manual proxy', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
              'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await createProvider();
    const model = provider.getModelInstance({
      model: 'gpt-5.5',
      apiKeys: { ChatGPTSubscription: 'test.jwt.token' },
    });
    const result = await model.doGenerate({
      prompt: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: [{ type: 'text', text: 'say hello' }] },
      ],
      mode: { type: 'regular' },
      inputFormat: 'messages',
    } as any);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test.jwt.token',
          originator: 'codex_cli_rs',
        }),
      }),
    );
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 1 });
  });
});
