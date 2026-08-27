import type { FileMap } from '~/lib/.server/llm/constants';

export type CodexUsagePhase = 'request' | 'response';
export type CodexUsageWarningLevel = 'info' | 'warning';

export interface CodexUsageAnnotation {
  type: 'codexUsage';
  value: {
    provider: 'ChatGPTSubscription';
    model: string;
    phase: CodexUsagePhase;
    warningLevel: CodexUsageWarningLevel;
    message: string;
    estimatedPromptTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

const CODEX_PROVIDER_NAME = 'ChatGPTSubscription';
const LARGE_CONTEXT_WARNING_TOKENS = 50_000;

export function isChatGPTSubscriptionProvider(providerName?: string): providerName is 'ChatGPTSubscription' {
  return providerName === CODEX_PROVIDER_NAME;
}

export function estimateTokensFromText(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function formatTokens(tokens: number): string {
  return Math.max(0, tokens).toLocaleString('en-US');
}

function getFileContent(file: unknown): string {
  if (!file || typeof file !== 'object') {
    return '';
  }

  const maybeContent = (file as { content?: unknown }).content;

  return typeof maybeContent === 'string' ? maybeContent : '';
}

export function estimateTokensFromFiles(files?: FileMap): number {
  if (!files) {
    return 0;
  }

  return Object.values(files).reduce((total, file) => total + estimateTokensFromText(getFileContent(file)), 0);
}

export function buildCodexRequestUsageAnnotation(input: {
  provider: string;
  model: string;
  messageText: string;
  contextFiles?: FileMap;
}): CodexUsageAnnotation {
  const estimatedPromptTokens = estimateTokensFromText(input.messageText) + estimateTokensFromFiles(input.contextFiles);
  const warningLevel: CodexUsageWarningLevel =
    estimatedPromptTokens >= LARGE_CONTEXT_WARNING_TOKENS ? 'warning' : 'info';
  const message =
    warningLevel === 'warning'
      ? `Large ChatGPT/Codex subscription request: about ${formatTokens(
          estimatedPromptTokens,
        )} prompt tokens before model output.`
      : `ChatGPT/Codex subscription request: about ${formatTokens(estimatedPromptTokens)} prompt tokens before model output.`;

  return {
    type: 'codexUsage',
    value: {
      provider: CODEX_PROVIDER_NAME,
      model: input.model,
      phase: 'request',
      estimatedPromptTokens,
      warningLevel,
      message,
    },
  };
}

export function buildCodexResponseUsageAnnotation(input: {
  provider: string;
  model: string;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}): CodexUsageAnnotation {
  const promptTokens = input.usage.promptTokens || 0;
  const completionTokens = input.usage.completionTokens || 0;
  const totalTokens = input.usage.totalTokens || promptTokens + completionTokens;

  return {
    type: 'codexUsage',
    value: {
      provider: CODEX_PROVIDER_NAME,
      model: input.model,
      phase: 'response',
      promptTokens,
      completionTokens,
      totalTokens,
      warningLevel: 'info',
      message: `ChatGPT/Codex subscription usage: ${formatTokens(totalTokens)} tokens (prompt: ${formatTokens(
        promptTokens,
      )}, completion: ${formatTokens(completionTokens)}).`,
    },
  };
}
