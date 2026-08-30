import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV1 } from 'ai';
import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import { logger } from '~/utils/logger';

interface ClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface AnthropicModelsResponse {
  data?: Array<{
    type?: string;
    id?: string;
    display_name?: string;
    max_input_tokens?: number;
    max_tokens?: number;
  }>;
}

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_COMPLETION_TOKENS = 8192;
const CLAUDE_CODE_BILLING_MARKER =
  'x-anthropic-billing-header: cc_version=2.1.251.bolt; cc_entrypoint=sdk-cli; cch=bolt;';
const DEFAULT_CLAUDE_MODELS: ModelInfo[] = [
  {
    name: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (Claude Subscription)',
    provider: 'ClaudeSubscription',
    maxTokenAllowed: DEFAULT_CONTEXT_WINDOW,
    maxCompletionTokens: DEFAULT_COMPLETION_TOKENS,
  },
  {
    name: 'claude-opus-5',
    label: 'Claude Opus 5 (Claude Subscription)',
    provider: 'ClaudeSubscription',
    maxTokenAllowed: 1000000,
    maxCompletionTokens: 128000,
  },
];

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getProcessEnv(): Record<string, string | undefined> {
  return isRecord(globalThis) && isRecord((globalThis as any).process) && isRecord((globalThis as any).process.env)
    ? (globalThis as any).process.env
    : {};
}

async function readJsonFile(path: string): Promise<Record<string, any> | undefined> {
  if (!isRecord((globalThis as any).process?.versions)) {
    return undefined;
  }

  try {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(content);

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractClaudeCredentials(authStore: Record<string, any>): ClaudeCredentials | undefined {
  const credentials = authStore.claudeAiOauth;

  if (isRecord(credentials) && typeof credentials.accessToken === 'string' && credentials.accessToken.trim()) {
    return {
      accessToken: credentials.accessToken.trim(),
      refreshToken: typeof credentials.refreshToken === 'string' ? credentials.refreshToken.trim() : undefined,
      expiresAt: typeof credentials.expiresAt === 'number' ? credentials.expiresAt : undefined,
    };
  }

  return undefined;
}

async function readClaudeCredentialsFromDisk(): Promise<ClaudeCredentials | undefined> {
  const home = getProcessEnv().HOME;

  if (!home) {
    return undefined;
  }

  const claudeCredentials = await readJsonFile(`${home}/.claude/.credentials.json`);

  return claudeCredentials ? extractClaudeCredentials(claudeCredentials) : undefined;
}

function tokenNeedsRefresh(expiresAt?: number): boolean {
  if (!expiresAt) {
    return false;
  }

  return expiresAt < Date.now() + 60_000;
}

async function refreshClaudeAccessToken(credentials: ClaudeCredentials): Promise<string> {
  if (!credentials.refreshToken || !tokenNeedsRefresh(credentials.expiresAt)) {
    return credentials.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
  });

  const response = await fetch(`${ANTHROPIC_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body,
  });

  if (!response.ok) {
    logger.warn(`Claude subscription token refresh failed with HTTP ${response.status}; using existing access token`);

    return credentials.accessToken;
  }

  const data = (await response.json()) as any;
  const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : '';

  return accessToken || credentials.accessToken;
}

async function resolveClaudeAccessToken(options: {
  apiKeys?: Record<string, string>;
  serverEnv?: Record<string, string>;
  providerName: string;
}): Promise<string> {
  const explicitToken =
    options.apiKeys?.[options.providerName] ||
    options.serverEnv?.CLAUDE_CODE_ACCESS_TOKEN ||
    getProcessEnv().CLAUDE_CODE_ACCESS_TOKEN;

  if (explicitToken?.trim()) {
    const refreshToken = options.serverEnv?.CLAUDE_CODE_REFRESH_TOKEN || getProcessEnv().CLAUDE_CODE_REFRESH_TOKEN;
    const expiresAt =
      Number(options.serverEnv?.CLAUDE_CODE_EXPIRES_AT || getProcessEnv().CLAUDE_CODE_EXPIRES_AT || 0) || undefined;

    return refreshClaudeAccessToken({
      accessToken: explicitToken.trim(),
      refreshToken: refreshToken?.trim() || undefined,
      expiresAt,
    });
  }

  const diskCredentials = await readClaudeCredentialsFromDisk();

  if (!diskCredentials?.accessToken) {
    throw new Error(
      'Missing Claude Code OAuth token. Run Claude Code /login, or set CLAUDE_CODE_ACCESS_TOKEN and CLAUDE_CODE_REFRESH_TOKEN.',
    );
  }

  return refreshClaudeAccessToken(diskCredentials);
}

function claudeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-version': '2023-06-01',
  };
}

function modelInfoFromAnthropicModel(model: NonNullable<AnthropicModelsResponse['data']>[number]): ModelInfo {
  const contextWindow = model.max_input_tokens || DEFAULT_CONTEXT_WINDOW;
  const maxCompletionTokens = Math.min(model.max_tokens || DEFAULT_COMPLETION_TOKENS, DEFAULT_COMPLETION_TOKENS);
  const name = model.id!.trim();
  const displayName = model.display_name || name;

  return {
    name,
    label: `${displayName} (Claude Subscription)`,
    provider: 'ClaudeSubscription',
    maxTokenAllowed: contextWindow,
    maxCompletionTokens,
  };
}

function systemIncludesClaudeCodeBillingMarker(system: unknown): boolean {
  if (typeof system === 'string') {
    return system.includes('x-anthropic-billing-header:');
  }

  if (Array.isArray(system)) {
    return system.some(
      (block) =>
        isRecord(block) && typeof block.text === 'string' && block.text.includes('x-anthropic-billing-header:'),
    );
  }

  return false;
}

function prependClaudeCodeBillingMarker(system: unknown): unknown {
  if (systemIncludesClaudeCodeBillingMarker(system)) {
    return system;
  }

  if (typeof system === 'string') {
    return `${CLAUDE_CODE_BILLING_MARKER}\n${system}`;
  }

  if (Array.isArray(system)) {
    return [{ type: 'text', text: CLAUDE_CODE_BILLING_MARKER }, ...system];
  }

  return CLAUDE_CODE_BILLING_MARKER;
}

function normalizeClaudeMessagesRequestBody(parsedBody: Record<string, any>): boolean {
  if (typeof parsedBody.model !== 'string' || !parsedBody.model.startsWith('claude-')) {
    return false;
  }

  let changed = false;

  if ('temperature' in parsedBody) {
    delete parsedBody.temperature;
    changed = true;
  }

  if (!systemIncludesClaudeCodeBillingMarker(parsedBody.system)) {
    parsedBody.system = prependClaudeCodeBillingMarker(parsedBody.system);
    changed = true;
  }

  return changed;
}

export function withoutApiKeyHeader(fetchFn: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const nextInit: RequestInit = { ...(init || {}) };
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete('x-api-key');
    nextInit.headers = headers;

    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/v1/messages')) {
      const requestBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);

      if (typeof requestBody === 'string') {
        try {
          const parsedBody = JSON.parse(requestBody);

          if (isRecord(parsedBody) && normalizeClaudeMessagesRequestBody(parsedBody)) {
            nextInit.body = JSON.stringify(parsedBody);
          }
        } catch {
          // Leave non-JSON request bodies untouched.
        }
      }
    }

    const response = await fetchFn(input, nextInit);

    if (response.status === 429) {
      try {
        const body = (await response.clone().json()) as any;

        if (body?.error?.type === 'rate_limit_error' && body.error.message === 'Error') {
          body.error.message = 'ClaudeSubscription is rate limited by Anthropic for this model/account right now';

          return new Response(JSON.stringify(body), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch {
        // Preserve the original response if it cannot be parsed.
      }
    }

    return response;
  }) as typeof fetch;
}

function createClaudeOAuthModel(model: string, accessToken: string): LanguageModelV1 {
  const anthropic = createAnthropic({
    apiKey: 'oauth-placeholder',
    headers: {
      ...claudeHeaders(accessToken.trim()),
      'anthropic-beta': 'output-128k-2025-02-19',
    },
    fetch: withoutApiKeyHeader(fetch),
  });

  return anthropic(model);
}

class ClaudeSubscriptionLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly provider = 'ClaudeSubscription';
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;

  constructor(
    readonly modelId: string,
    private readonly _apiKeys: Record<string, string> | undefined,
    private readonly _serverEnv: Record<string, string>,
  ) {}

  private async _delegate(): Promise<LanguageModelV1> {
    const accessToken = await resolveClaudeAccessToken({
      apiKeys: this._apiKeys,
      serverEnv: this._serverEnv,
      providerName: 'ClaudeSubscription',
    });

    return createClaudeOAuthModel(this.modelId, accessToken);
  }

  async doGenerate(options: any) {
    const delegate = await this._delegate();

    return delegate.doGenerate(options);
  }

  async doStream(options: any) {
    const delegate = await this._delegate();

    return delegate.doStream(options);
  }
}

export default class ClaudeSubscriptionProvider extends BaseProvider {
  name = 'ClaudeSubscription';
  getApiKeyLink = undefined;
  labelForGetApiKey = 'Use Claude Code OAuth';
  icon = 'i-ph:terminal-window';

  config = {
    apiTokenKey: 'CLAUDE_CODE_ACCESS_TOKEN',
  };

  staticModels: ModelInfo[] = DEFAULT_CLAUDE_MODELS;

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const accessToken = await resolveClaudeAccessToken({ apiKeys, serverEnv, providerName: this.name });
    const response = await fetch(`${ANTHROPIC_BASE_URL}/models`, {
      headers: claudeHeaders(accessToken),
      signal: this.createTimeoutSignal(10_000),
    });

    if (!response.ok) {
      logger.warn(`ClaudeSubscription model discovery failed with HTTP ${response.status}; using fallback models`);

      return this.staticModels;
    }

    const data = (await response.json()) as AnthropicModelsResponse;
    const models = Array.isArray(data.data) ? data.data : [];

    return models
      .filter((model) => model.type === 'model' && typeof model.id === 'string' && model.id.trim())
      .map(modelInfoFromAnthropicModel);
  }

  getModelInstance(options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    return new ClaudeSubscriptionLanguageModel(model, apiKeys, envRecord);
  }
}
