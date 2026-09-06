import { requireUser } from '@/lib/supabase/auth';
import { planProjectChange } from '@/lib/agent/planner';
import { streamWithGateway } from '@/lib/ai/gateway';
import { guardRequest, readJson, validateRelativePath } from '@/lib/security';

const enc = new TextEncoder();
const sse = (event:string, data:unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function POST(req:Request,{params}:{params:Promise<{chatId:string}>}){
  const {chatId}=await params;
  const guard=await guardRequest(req,'chat-generation',12);
  if(guard instanceof Response) return guard;
  const {supabase,user}=guard as any;
  const {data:chat}=await supabase.from('chats').select('id,project_id,projects!inner(owner_id)').eq('id',chatId).eq('projects.owner_id',user.id).single();
  if(!chat) return new Response(JSON.stringify({error:'Chat not found.'}),{status:404,headers:{'content-type':'application/json'}});
  let body: Record<string, unknown>;
  try { body = await readJson(req); } catch (error) { return new Response(JSON.stringify({error:error instanceof Error?error.message:'Invalid JSON.'}),{status:400,headers:{'content-type':'application/json'}}); }
  const content=typeof body.content==='string'?body.content.trim():'';
  if(content.length > 12000) return new Response(JSON.stringify({error:'Message is too long.'}),{status:413,headers:{'content-type':'application/json'}});
  if(!content) return new Response(JSON.stringify({error:'Message is required.'}),{status:400,headers:{'content-type':'application/json'}});
  await supabase.from('messages').insert({chat_id:chatId,role:'user',content});
  const {data:files}=await supabase.from('project_files').select('path,content').eq('project_id',chat.project_id);
  const {data:memory}=await supabase.from('memories').select('content').eq('project_id',chat.project_id).order('created_at',{ascending:false}).limit(30);
  const {data:history}=await supabase.from('messages').select('role,content').eq('chat_id',chatId).order('created_at',{ascending:false}).limit(30);
  const conversation=(history??[]).reverse().map((m:{role:string;content:string})=>`${m.role.toUpperCase()}: ${m.content}`);

  const stream=new ReadableStream<Uint8Array>({async start(controller){
    try{
      controller.enqueue(sse('status',{text:'Reading project context…'}));
      const plan=await planProjectChange({request:content,files:files??[],projectMemory:(memory??[]).map((m:{content:string})=>m.content),conversation});
      controller.enqueue(sse('plan',{summary:plan.summary,actions:plan.actions.map(a=>({type:a.type,path:'path' in a?a.path:undefined}))}));
      let changed=0;
      for(const action of plan.actions){
        if(action.type==='create_file'||action.type==='update_file'){const path=validateRelativePath(action.path);if(action.content.length>1_000_000)throw new Error('Generated file is too large.');const current=await supabase.from('project_files').select('version').eq('project_id',chat.project_id).eq('path',path).maybeSingle();if(current.error)throw current.error;const {error}=await supabase.from('project_files').upsert({project_id:chat.project_id,path,content:action.content,version:(current.data?.version??0)+1,updated_at:new Date().toISOString()},{onConflict:'project_id,path'});if(error)throw error;changed++;}
        else if(action.type==='delete_file'){const path=validateRelativePath(action.path);const {error}=await supabase.from('project_files').delete().eq('project_id',chat.project_id).eq('path',path);if(error)throw error;changed++;}
        else if(action.type==='save_memory'){const {error}=await supabase.from('memories').insert({project_id:chat.project_id,type:action.memoryType,content:action.content});if(error)throw error;}
      }
      controller.enqueue(sse('status',{text:`Applied ${changed} file change(s).` }));
      let final='';
      try{
        const providerStream=await streamWithGateway({system:'You are Nexa Code AI. Explain completed project changes honestly. Never claim code was executed or tested.',user:`The user asked: ${content}\n\nPlan summary: ${plan.summary}\n\nNotes: ${plan.notes.join('\n')}\n\nWrite a concise helpful response describing what changed and any important next steps.`});
        const reader=providerStream.getReader(); const decoder=new TextDecoder(); let buffer='';
        while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';for(const line of lines){if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(raw==='[DONE]')continue;try{const j=JSON.parse(raw);const text=j.choices?.[0]?.delta?.content??j.candidates?.[0]?.content?.parts?.[0]?.text??'';if(text){final+=text;controller.enqueue(sse('token',{text}));}}catch{}}}
      }catch{ final=`${plan.summary}\n\n${plan.notes.length?plan.notes.map(n=>`- ${n}`).join('\n'):'Project changes have been applied to the workspace.'}`; controller.enqueue(sse('token',{text:final})); }
      const {data:assistant,error}=await supabase.from('messages').insert({chat_id:chatId,role:'assistant',content:final}).select().single(); if(error)throw error;
      await supabase.from('chats').update({updated_at:new Date().toISOString()}).eq('id',chatId);
      controller.enqueue(sse('done',{message:assistant,plan})); controller.close();
    }catch(error){controller.enqueue(sse('error',{message:error instanceof Error?error.message:'Agent request failed.'}));controller.close();}
  }});
  return new Response(stream,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive'}});
}
