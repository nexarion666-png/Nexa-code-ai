import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';

export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const { supabase, user } = await requireUser();

    const { data: run, error: runError } = await supabase
      .from('agent_runs')
      .select('*,projects!inner(owner_id)')
      .eq('id', runId)
      .eq('projects.owner_id', user.id)
      .single();

    if (runError || !run) {
      return NextResponse.json(
        { error: 'Agent proposal not found.' },
        { status: 404 }
      );
    }

    if (run.status !== 'pending') {
      return NextResponse.json(
        { error: `This proposal is already ${run.status}.` },
        { status: 409 }
      );
    }

    const { error: updateError } = await supabase
      .from('agent_runs')
      .update({
        status: 'rejected',
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .eq('status', 'pending');

    if (updateError) throw updateError;

    if (run.chat_id) {
      await supabase
        .from('messages')
        .insert({
          chat_id: run.chat_id,
          role: 'assistant',
          content: 'The proposed changes were rejected. No project files were changed.',
        });

      await supabase
        .from('chats')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', run.chat_id);
    }

    return NextResponse.json({
      runId,
      status: 'rejected',
      summary: 'The proposal was rejected. No project files were changed.',
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : 'Could not reject agent proposal.';

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
