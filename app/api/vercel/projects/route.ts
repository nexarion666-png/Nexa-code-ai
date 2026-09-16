import { NextResponse } from 'next/server';
import { listVercelProjects } from '@/lib/vercel';
import { requireUser } from '@/lib/supabase/auth';
export async function GET(){try{await requireUser();const token=process.env.VERCEL_TOKEN;if(!token)return NextResponse.json({configured:false,projects:[]});return NextResponse.json({configured:true,projects:(await listVercelProjects(token)).projects??[]});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Could not load Vercel projects.'},{status:400});}}
