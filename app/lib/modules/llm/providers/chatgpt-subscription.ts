import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

interface CodexModelsResponse {
  models?: Array<{ slug?: string; visibility?: string; priority?: number }>;
}

interface CodexTokens {
  accessToken: string;
  refreshToken?: string;
}

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_MODELS_URL = `${CODEX_BASE_URL}/models?client_version=1.0.0`;
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_COMPLETION_TOKENS = 128000;
const DEFAULT_CODEX_MODELS = ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'];

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeJwtPayload(token: string): Record<string, any> | undefined {
  try {
    const payload = token.split('.')[1];

    if (!payload) {
      return undefined;
    }

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const decoded = globalThis.atob(padded);

    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
}

function getChatGPTAccountId(accessToken: string, explicitAccountId?: string): string | undefined {
  if (explicitAccountId?.trim()) {
    return explicitAccountId.trim();
  }

  const claims = decodeJwtPayload(accessToken);
  const authClaims = claims?.['https://api.openai.com/auth'];
  const accountId = isRecord(authClaims) ? authClaims.chatgpt_account_id : undefined;

  return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : undefined;
}

function isTokenExpired(accessToken: string): boolean {
  const claims = decodeJwtPayload(accessToken);
  const exp = typeof claims?.exp === 'number' ? claims.exp : undefined;

  if (!exp) {
    return false;
  }

  return exp * 1000 < Date.now() + 60_000;
}

async function readJsonFile(path: string): Promise<Record<string, any> | undefined> {
  try {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(content);

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractTokensFromHermesAuth(authStore: Record<string, any>): CodexTokens | undefined {
  const providerTokens = authStore.providers?.['openai-codex']?.tokens;

  if (
    isRecord(providerTokens) &&
    typeof providerTokens.access_token === 'string' &&
    providerTokens.access_token.trim()
  ) {
    return {
      accessToken: providerTokens.access_token.trim(),
      refreshToken: typeof providerTokens.refresh_token === 'string' ? providerTokens.refresh_token.trim() : undefined,
    };
  }

  const poolEntries = authStore.credential_pool?.['openai-codex'];

  if (Array.isArray(poolEntries)) {
    for (const entry of poolEntries) {
      if (isRecord(entry) && typeof entry.access_token === 'string' && entry.access_token.trim()) {
        return {
          accessToken: entry.access_token.trim(),
          refreshToken: typeof entry.refresh_token === 'string' ? entry.refresh_token.trim() : undefined,
        };
      }
    }
  }

  return undefined;
}

function extractTokensFromCodexCliAuth(authStore: Record<string, any>): CodexTokens | undefined {
  const tokens = authStore.tokens || authStore.openai || authStore;

  if (isRecord(tokens) && typeof tokens.access_token === 'string' && tokens.access_token.trim()) {
    return {
      accessToken: tokens.access_token.trim(),
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token.trim() : undefined,
    };
  }

  return undefined;
}

async function readCodexTokensFromDisk(): Promise<CodexTokens | undefined> {
  const home = process?.env?.HOME;

  if (!home) {
    return undefined;
  }

  const hermesAuth = await readJsonFile(`${home}/.hermes/auth.json`);

  if (hermesAuth) {
    const tokens = extractTokensFromHermesAuth(hermesAuth);

    if (tokens) {
      return tokens;
    }
  }

  const codexAuth = await readJsonFile(`${home}/.codex/auth.json`);

  if (codexAuth) {
    return extractTokensFromCodexCliAuth(codexAuth);
  }

  return undefined;
}

async function refreshCodexAccessToken(tokens: CodexTokens): Promise<string> {
  if (!tokens.refreshToken || !isTokenExpired(tokens.accessToken)) {
    return tokens.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    logger.warn(`Codex token refresh failed with HTTP ${response.status}; using existing access token`);

    return tokens.accessToken;
  }

  const data = (await response.json()) as any;
  const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : '';

  return accessToken || tokens.accessToken;
}

async function resolveCodexAccessToken(options: {
  apiKeys?: Record<string, string>;
  serverEnv?: Record<string, string>;
  providerName: string;
}): Promise<string> {
  const explicitToken =
    options.apiKeys?.[options.providerName] ||
    options.serverEnv?.CHATGPT_CODEX_ACCESS_TOKEN ||
    options.serverEnv?.CHATGPT_SUBSCRIPTION_API_KEY ||
    process?.env?.CHATGPT_CODEX_ACCESS_TOKEN ||
    process?.env?.CHATGPT_SUBSCRIPTION_API_KEY;

  if (explicitToken?.trim()) {
    const refreshToken = options.serverEnv?.CHATGPT_CODEX_REFRESH_TOKEN || process?.env?.CHATGPT_CODEX_REFRESH_TOKEN;

    return refreshCodexAccessToken({
      accessToken: explicitToken.trim(),
      refreshToken: refreshToken?.trim() || undefined,
    });
  }

  const diskTokens = await readCodexTokensFromDisk();

  if (!diskTokens?.accessToken) {
    throw new Error(
      'Missing ChatGPT/Codex OAuth token. Run `hermes auth add openai-codex` or Codex CLI login, or set CHATGPT_CODEX_ACCESS_TOKEN.',
    );
  }

  return refreshCodexAccessToken(diskTokens);
}

function codexHeaders(accessToken: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.0.0 (bolt.diy)',
    originator: 'codex_cli_rs',
  };

  const resolvedAccountId = getChatGPTAccountId(accessToken, accountId);

  if (resolvedAccountId) {
    headers['ChatGPT-Account-ID'] = resolvedAccountId;
  }

  return headers;
}

function promptToCodexInput(prompt: any[]): Array<Record<string, any>> {
  const input: Array<Record<string, any>> = [];

  for (const message of prompt) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content || []) {
        if (part?.type !== 'tool-result') {
          continue;
        }

        input.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? ''),
        });
      }

      continue;
    }

    if (message.role === 'assistant') {
      const content = message.content || [];
      const text = content
        .filter((part: any) => part?.type === 'text')
        .map((part: any) => part.text || '')
        .join('');

      if (text) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      }

      for (const part of content) {
        if (part?.type === 'tool-call') {
          input.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.args ?? {}),
          });
        }
      }

      continue;
    }

    const content = (message.content || [])
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => ({ type: 'input_text', text: part.text || '' }));

    input.push({ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '' }] });
  }

  return input.length ? input : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }];
}

function systemPromptFromPrompt(prompt: any[]): string {
  return prompt
    .filter((message) => message?.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n\n');
}

function toolsToCodexTools(mode: any): Array<Record<string, any>> | undefined {
  const tools = mode?.type === 'regular' && Array.isArray(mode.tools) ? mode.tools : undefined;

  if (!tools?.length) {
    return undefined;
  }

  return tools
    .filter((tool: any) => tool?.type === 'function')
    .map((tool: any) => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || {},
    }));
}

function mapFinishReason(status?: string): 'stop' | 'length' | 'error' | 'unknown' {
  if (status === 'incomplete') {
    return 'length';
  }

  if (status === 'failed') {
    return 'error';
  }

  return status ? 'stop' : 'unknown';
}

class ChatGPTSubscriptionLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly provider = 'ChatGPTSubscription';
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = true;

  constructor(
    readonly modelId: string,
    private readonly _accessToken: string | undefined,
    private readonly _serverEnv: Record<string, string>,
    private readonly _accountId?: string,
  ) {}

  async doGenerate(options: any) {
    const result = await this.doStream(options);
    const reader = result.stream.getReader();
    let text = '';
    let finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown' = 'unknown';
    let usage = { promptTokens: 0, completionTokens: 0 };
    const toolCalls: any[] = [];

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value.type === 'text-delta') {
        text += value.textDelta;
      } else if (value.type === 'tool-call') {
        toolCalls.push(value);
      } else if (value.type === 'finish') {
        finishReason = value.finishReason;
        usage = value.usage;
      }
    }

    return {
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
      usage,
      rawCall: result.rawCall,
      request: result.request,
      warnings: [],
    };
  }

  async doStream(options: any) {
    const accessToken =
      this._accessToken ||
      (await resolveCodexAccessToken({
        serverEnv: this._serverEnv,
        providerName: 'ChatGPTSubscription',
      }));
    const input = promptToCodexInput(options.prompt || []);
    const instructions = systemPromptFromPrompt(options.prompt || []) || 'You are a helpful assistant.';
    const tools = toolsToCodexTools(options.mode);
    const requestBody: Record<string, any> = {
      model: this.modelId,
      instructions,
      input,
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    };

    if (tools?.length) {
      requestBody.tools = tools;
      requestBody.tool_choice = options.mode?.toolChoice || 'auto';
      requestBody.parallel_tool_calls = true;
    }

    const response = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: 'POST',
      headers: codexHeaders(accessToken, this._accountId),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal,
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`ChatGPT Codex request failed with HTTP ${response.status}: ${errorText || response.statusText}`);
    }

    const stream = this._toLanguageModelStream(response.body);

    return {
      stream,
      rawCall: {
        rawPrompt: input,
        rawSettings: { model: this.modelId },
      },
      rawResponse: {
        headers: Object.fromEntries(response.headers.entries()),
      },
      request: {
        body: JSON.stringify(requestBody),
      },
      warnings: [],
    };
  }

  private _toLanguageModelStream(responseBody: ReadableStream<Uint8Array>): ReadableStream<any> {
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: 'stop' | 'length' | 'error' | 'unknown' = 'unknown';
    let sawTextDelta = false;
    const emittedToolCalls = new Set<string>();

    return new ReadableStream({
      async start(controller) {
        const reader = responseBody.getReader();

        const handleEvent = (event: Record<string, any>) => {
          const type = event.type;

          if (typeof event.response?.id === 'string') {
            controller.enqueue({ type: 'response-metadata', id: event.response.id, modelId: event.response.model });
          }

          if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
            sawTextDelta = true;
            controller.enqueue({ type: 'text-delta', textDelta: event.delta });
          }

          if (type === 'response.output_item.done') {
            const item = event.item;

            if (item?.type === 'message' && !sawTextDelta) {
              for (const part of item.content || []) {
                if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
                  controller.enqueue({ type: 'text-delta', textDelta: part.text });
                }
              }
            }

            if (item?.type === 'function_call' && item.call_id && !emittedToolCalls.has(item.call_id)) {
              emittedToolCalls.add(item.call_id);
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: item.call_id,
                toolName: item.name || '',
                args: item.arguments || '{}',
              });
            }
          }

          if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
            const response = event.response || {};
            promptTokens = response.usage?.input_tokens || promptTokens;
            completionTokens = response.usage?.output_tokens || completionTokens;
            finishReason = mapFinishReason(response.status);
          }

          if (event.error) {
            controller.enqueue({ type: 'error', error: event.error });
          }
        };

        const flushBuffer = () => {
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const eventText of events) {
            const dataLines = eventText
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .filter((line) => line && line !== '[DONE]');

            for (const dataLine of dataLines) {
              try {
                handleEvent(JSON.parse(dataLine));
              } catch (error) {
                controller.enqueue({ type: 'error', error });
              }
            }
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            flushBuffer();
          }

          buffer += decoder.decode();

          if (buffer.trim()) {
            buffer += '\n\n';
            flushBuffer();
          }

          controller.enqueue({
            type: 'finish',
            finishReason,
            usage: { promptTokens, completionTokens },
          });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: 'error', error });
          controller.close();
        }
      },
    });
  }
}

export default class ChatGPTSubscriptionProvider extends BaseProvider {
  name = 'ChatGPTSubscription';
  getApiKeyLink = undefined;
  labelForGetApiKey = 'Use Hermes/Codex OAuth';
  icon = 'i-ph:terminal-window';

  config = {
    apiTokenKey: 'CHATGPT_CODEX_ACCESS_TOKEN',
  };

  staticModels: ModelInfo[] = DEFAULT_CODEX_MODELS.map((model) => ({
    name: model,
    label: `${model} (ChatGPT Subscription)`,
    provider: this.name,
    maxTokenAllowed: DEFAULT_CONTEXT_WINDOW,
    maxCompletionTokens: DEFAULT_COMPLETION_TOKENS,
  }));

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const accessToken = await resolveCodexAccessToken({ apiKeys, serverEnv, providerName: this.name });
    const accountId = serverEnv.CHATGPT_CODEX_ACCOUNT_ID || process?.env?.CHATGPT_CODEX_ACCOUNT_ID;
    const response = await fetch(CODEX_MODELS_URL, {
      headers: codexHeaders(accessToken, accountId),
      signal: this.createTimeoutSignal(10_000),
    });

    if (!response.ok) {
      logger.warn(`ChatGPTSubscription model discovery failed with HTTP ${response.status}; using fallback models`);

      return this.staticModels;
    }

    const data = (await response.json()) as CodexModelsResponse;
    const models = Array.isArray(data.models) ? data.models : [];

    return models
      .filter((model) => typeof model.slug === 'string' && model.slug.trim())
      .filter((model) => !['hide', 'hidden'].includes(String(model.visibility || '').toLowerCase()))
      .sort((a, b) => (a.priority ?? 10_000) - (b.priority ?? 10_000) || String(a.slug).localeCompare(String(b.slug)))
      .map((model) => ({
        name: model.slug!.trim(),
        label: `${model.slug!.trim()} (ChatGPT Subscription)`,
        provider: this.name,
        maxTokenAllowed: DEFAULT_CONTEXT_WINDOW,
        maxCompletionTokens: DEFAULT_COMPLETION_TOKENS,
      }));
  }

  getModelInstance(options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);
    const uiAccessToken = apiKeys?.[this.name]?.trim() || undefined;

    const accountId = envRecord.CHATGPT_CODEX_ACCOUNT_ID || process?.env?.CHATGPT_CODEX_ACCOUNT_ID;

    return new ChatGPTSubscriptionLanguageModel(model, uiAccessToken, envRecord, accountId);
  }
}
