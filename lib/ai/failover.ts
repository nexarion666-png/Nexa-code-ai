export type Provider = 'gemini' | 'groq' | 'openrouter';

export const FAILOVER_ORDER: Record<Provider, string[]> = {
  gemini: ['gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  openrouter: ['google/gemini-2.0-flash-001'],
};

const failedKeys = new Map<string, number>();
const COOLDOWN = 60_000;
const TIMEOUT = 8000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT);
    p.then(v => { clearTimeout(t); resolve(v); }).catch(e => { clearTimeout(t); reject(e); });
  });
}

export async function streamWithFailover(args: {
  provider: Provider;
  model: string;
  messages: any[];
  keys: string[];
  keysByProvider: Record<Provider, string[]>;
  onChunk: (c: string) => Promise<void> | void;
}) {
  const models = FAILOVER_ORDER[args.provider] || [args.model];
  const allKeys = args.keysByProvider[args.provider] || args.keys;

  for (const model of models) {
    for (const key of allKeys) {
      const failTime = failedKeys.get(key);
      if (failTime && Date.now() - failTime < COOLDOWN) continue;
      try {
        const result = await withTimeout((async () => {
          if (args.provider === 'gemini') {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(key);
            const gModel = genAI.getGenerativeModel({ model });
            const prompt = args.messages.map((m: any) => m.content).join('\n');
            const stream = await gModel.generateContentStream(prompt);
            for await (const chunk of stream.stream) {
              const text = chunk.text();
              if (text) await args.onChunk(text);
            }
            return true;
          }
          if (args.provider === 'groq') {
            const { default: Groq } = await import('groq-sdk');
            const groq = new Groq({ apiKey: key });
            const s = await groq.chat.completions.create({
              model, messages: args.messages, stream: true,
            });
            for await (const c of s) {
              const t = c.choices[0]?.delta?.content || '';
              if (t) await args.onChunk(t);
            }
            return true;
          }
          // openrouter
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: args.messages, stream: true }),
          });
          if (!res.ok ||!res.body) throw new Error('openrouter fail');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const txt = decoder.decode(value);
            const lines = txt.split('\n').filter(l => l.startsWith('data: '));
            for (const line of lines) {
              if (line.includes('[DONE]')) break;
              try {
                const json = JSON.parse(line.slice(6));
                const content = json.choices?.[0]?.delta?.content;
                if (content) await args.onChunk(content);
              } catch {}
            }
          }
          return true;
        })());
        if (result) return;
      } catch (e: any) {
        failedKeys.set(key, Date.now());
        continue;
      }
    }
  }
  throw new Error('KEYS_EXHAUSTED');
}
