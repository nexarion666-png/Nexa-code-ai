import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptApiKey } from '@/lib/ai/crypto';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const supabase = await createClient(); const { data:{user} } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({error:'Unauthorized'},{status:401});
  const body=await request.json().catch(()=>({})); const projectId=String(body.projectId??'').trim();
  if(!projectId) return NextResponse.json({error:'projectId is required.'},{status:400});
  const {data:project,error:pe}=await supabase.from('projects').select('id,name').eq('id',projectId).eq('user_id',user.id).single();
  if(pe||!project) return NextResponse.json({error:'Project not found.'},{status:404});
  const {data:cred}=await supabase.from('user_github_tokens').select('vercel_token').eq('user_id',user.id).maybeSingle();
  if(!cred?.vercel_token) return NextResponse.json({error:'Connect Vercel token in settings'},{status:400});
  let token:string; try{token=decryptApiKey(cred.vercel_token)}catch{return NextResponse.json({error:'Saved Vercel token is invalid. Reconnect it in settings.'},{status:400});}
  const {data:files,error:fe}=await supabase.from('project_files').select('path,content').eq('project_id',projectId).order('path');
  if(fe)return NextResponse.json({error:fe.message},{status:500}); if(!files?.length)return NextResponse.json({error:'Add some project files before deploying.'},{status:400});
  const payload={name:String(project.name).toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,52)||`nexa-${projectId.slice(0,8)}`,files:files.map(f=>({file:f.path,data:Buffer.from(f.content??'','utf8').toString('base64')})),projectSettings:{framework:'nextjs'}};
  const response=await fetch('https://api.vercel.com/v13/deployments',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
  const raw=await response.text();
  let result: { url?: string; id?: string; readyState?: string; message?: string; error?: { message?: string } } = {};
  try { result = raw ? JSON.parse(raw) as typeof result : {}; } catch { result = { message: raw }; }
  if(!response.ok)return NextResponse.json({error:result?.error?.message||result?.message||`Vercel deployment failed (${response.status}).`},{status:response.status>=400&&response.status<500?response.status:502});
  const url=result.url?(String(result.url).startsWith('http')?String(result.url):`https://${result.url}`):null;
  const {data:deployment,error:ie}=await supabase.from('deployments').insert({project_id:projectId,user_id:user.id,url,status:result.readyState||'READY',vercel_deployment_id:result.id??null}).select('id,url,status,vercel_deployment_id,created_at').single();
  if(ie)return NextResponse.json({error:ie.message},{status:500}); return NextResponse.json({url,id:result.id,deployment});
}
