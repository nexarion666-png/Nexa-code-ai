import { AIProvider, ChatRequest, ProviderResult } from '../types';
export class GroqProvider implements AIProvider {
  name = 'groq';
  async complete(request: ChatRequest, key: string): Promise<ProviderResult> {
    const model = request.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'content-type':'application/json',Authorization:`Bearer ${key}`}, body:JSON.stringify({model,messages:[{role:'system',content:request.system??''},{role:'user',content:request.user}]}) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data=await response.json(); return {text:data.choices?.[0]?.message?.content??'',provider:this.name,model};
  }
  async stream(request: ChatRequest, key: string) {
    const model = request.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'content-type':'application/json',Authorization:`Bearer ${key}`}, body:JSON.stringify({model,stream:true,messages:[{role:'system',content:request.system??''},{role:'user',content:request.user}]}) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    return response.body;
  }
}
