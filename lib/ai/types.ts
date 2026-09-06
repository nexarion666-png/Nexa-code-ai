export type ChatRequest = { system?: string; user: string; model?: string };
export type ProviderResult = { text: string; provider: string; model: string };
export type StreamChunk = { text: string; provider: string; model: string; done?: boolean };
export interface AIProvider {
  name: string;
  complete(request: ChatRequest, key: string): Promise<ProviderResult>;
  stream?(request: ChatRequest, key: string): Promise<ReadableStream<Uint8Array>>;
}
