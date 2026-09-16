import { NextResponse } from 'next/server';
import { decryptSecret } from '@/lib/crypto';
import { getGitHubUser, listGitHubRepos } from '@/lib/github';
import { requireUser } from '@/lib/supabase/auth';
export async function GET() { try { const {supabase,user}=await requireUser(); const {data}=await supabase.from('github_connections').select('login,encrypted_token').eq('owner_id',user.id).single(); if(!data) return NextResponse.json({connected:false,repositories:[]}); const token=await decryptSecret(data.encrypted_token); const repos=await listGitHubRepos(token); return NextResponse.json({connected:true,login:data.login,repositories:(repos??[]).map((r:any)=>({id:r.id,name:r.name,full_name:r.full_name,private:r.private,default_branch:r.default_branch,html_url:r.html_url}))}); } catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Could not load GitHub repositories.'},{status:400});}}
