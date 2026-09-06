import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/security';
export async function POST(req: Request) { try { const { supabase } = await guardRequest(req, 'github-disconnect', 10) as any; await supabase.from('github_connections').delete().throwOnError(); return NextResponse.json({ ok: true }); } catch(e){ return NextResponse.json({error:e instanceof Error?e.message:'Could not disconnect GitHub.'},{status:400}); } }
