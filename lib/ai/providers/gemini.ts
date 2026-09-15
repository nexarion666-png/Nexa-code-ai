import { AIProvider, ChatRequest, ProviderResult } from '../types';

export class GeminiProvider implements AIProvider {
  name='google-ai-studio';

  async complete(request:ChatRequest,key:string):Promise<ProviderResult>{
    const model=request.model||process.env.GEMINI_MODEL||process.env.DEFAULT_MODEL||'gemini-3.1-flash-lite';
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        contents:[{
          role:'user',
          parts:[
            {text:`${request.system??''}\n\n${request.user}`},
            ...(request.image?[{inline_data:{mime_type:request.image.mimeType,data:request.image.data}}]:[])
          ]
        }]
      })
    });
    if(!response.ok){const error=await response.text();throw new Error(`HTTP ${response.status}: ${error}`);}
    const data=await response.json();
    return{text:data.candidates?.[0]?.content?.parts?.[0]?.text??'',provider:this.name,model};
  }

  async stream(request:ChatRequest,key:string){
    const model=request.model||process.env.GEMINI_MODEL||process.env.DEFAULT_MODEL||'gemini-3.1-flash-lite';
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        contents:[{
          role:'user',
          parts:[
            {text:`${request.system??''}\n\n${request.user}`},
            ...(request.image?[{inline_data:{mime_type:request.image.mimeType,data:request.image.data}}]:[])
          ]
        }]
      })
    });
    if(!response.ok||!response.body)throw new Error(`HTTP ${response.status}`);
    return response.body;
  }
}
