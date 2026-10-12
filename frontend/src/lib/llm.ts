// Where the configured model runs — shown as a badge so nobody sends portfolio data to a cloud model
// without seeing it. Mirrors the backend's LLMClient.is_remote(): "-cloud" / ":cloud" model tags
// (Ollama cloud models) or a base URL outside the machine / private network.
import type { LLMSettings } from '../types';

export type LlmLocality = 'none' | 'local' | 'remote';

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[\w-]+\.local|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

export function isCloudModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.endsWith('-cloud') || m.endsWith(':cloud');
}

export function llmLocality(llm: Pick<LLMSettings, 'base_url' | 'model'> | null | undefined): LlmLocality {
  if (!llm || !llm.base_url.trim()) return 'none';
  if (isCloudModel(llm.model)) return 'remote';
  let host = '';
  try {
    host = new URL(llm.base_url.trim()).hostname;
  } catch {
    return 'remote'; // unparseable URL: do not claim it is local
  }
  return LOCAL_HOST.test(host) ? 'local' : 'remote';
}
