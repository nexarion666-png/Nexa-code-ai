import { AIProvider, ChatRequest, ProviderResult } from './types';
import { GeminiProvider } from './providers/gemini';
import { GroqProvider } from './providers/groq';
import { OpenRouterProvider } from './providers/openrouter';
import { HuggingFaceProvider } from './providers/huggingface';
import { decryptSecret } from '@/lib/crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type Route = { provider: AIProvider; keys: string[] };
const splitKeys = (value?: string) => (value ?? '').split(',').map(x => x.trim()).filter(Boolean);
const modelFor = (name: string) => ({
  'google-ai-studio': process.env.GEMINI_MODEL || process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
  groq: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  openrouter: process.env.OPENROUTER_MODEL || 'openrouter/auto',
  huggingface: process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct',
}[name] ?? process.env.DEFAULT_MODEL ?? '');

export class AIGateway {
  private cooldown = new Map<string, number>();
  constructor(private routes: Route[]) {}
  private available(route: Route, key: string) { return (this.cooldown.get(`${route.provider.name}:${key}`) ?? 0) <= Date.now(); }
  private penalize(route: Route, key: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const ms = /429|rate.?limit|quota/i.test(message) ? 60_000 : 5_000;
    this.cooldown.set(`${route.provider.name}:${key}`, Date.now() + ms);
  }
  private requestFor(request: ChatRequest, provider: AIProvider): ChatRequest {
    return { ...request, model: request.model || modelFor(provider.name) };
  }
  async stream(request: ChatRequest): Promise<ReadableStream<Uint8Array>> {
    const failures: string[] = [];
    for (const route of this.routes) for (const key of route.keys) {
      if (!this.available(route, key) || !route.provider.stream) continue;
      try { return await route.provider.stream(this.requestFor(request, route.provider), key); }
      catch (error) { this.penalize(route, key, error); failures.push(`${route.provider.name}: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
    throw new Error(failures.length ? `No streaming AI route is available. ${failures.join(' | ')}` : 'No streaming AI providers are configured.');
  }
  async complete(request: ChatRequest): Promise<ProviderResult> {
    const failures: string[] = [];
    for (const route of this.routes) for (const key of route.keys) {
      if (!this.available(route, key)) continue;
      try { return await route.provider.complete(this.requestFor(request, route.provider), key); }
      catch (error) { this.penalize(route, key, error); failures.push(`${route.provider.name}: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
    throw new Error(failures.length ? `No AI route is currently available. ${failures.join(' | ')}` : 'No AI providers are configured. Add a provider API key.');
  }
}

function envRoutes(): Route[] { return [
  { provider: new GeminiProvider(), keys: splitKeys(process.env.GOOGLE_AI_API_KEYS) },
  { provider: new GroqProvider(), keys: splitKeys(process.env.GROQ_API_KEYS) },
  { provider: new OpenRouterProvider(), keys: splitKeys(process.env.OPENROUTER_API_KEYS) },
  { provider: new HuggingFaceProvider(), keys: splitKeys(process.env.HUGGINGFACE_API_KEYS) },
].filter(route => route.keys.length > 0); }

export async function createGatewayForUser() {
  const routes = envRoutes();
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.from('provider_keys').select('provider, encrypted_key, enabled').eq('enabled', true).order('priority').order('created_at');
    const grouped = new Map<string, string[]>();
    for (const row of data ?? []) {
      try {
        const key = await decryptSecret(row.encrypted_key);
        const list = grouped.get(row.provider) ?? [];
        list.push(key);
        grouped.set(row.provider, list);
      } catch { /* Keep server environment keys as fallback. */ }
    }
    for (const route of routes) route.keys = [...(grouped.get(route.provider.name) ?? []), ...route.keys];
    for (const [providerName, keys] of grouped) if (!routes.some(r => r.provider.name === providerName)) {
      const provider = providerName === 'google-ai-studio' ? new GeminiProvider() : providerName === 'groq' ? new GroqProvider() : providerName === 'openrouter' ? new OpenRouterProvider() : providerName === 'huggingface' ? new HuggingFaceProvider() : null;
      if (provider) routes.push({ provider, keys });
    }
  } catch { /* Unauthenticated/public paths fall back to environment keys. */ }
  return new AIGateway(routes);
}

export function createGateway() { return new AIGateway(envRoutes()); }
export async function streamWithGateway(request: ChatRequest) { return (await createGatewayForUser()).stream(request); }
