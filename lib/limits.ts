import type { SupabaseClient, User } from '@supabase/supabase-js';

export const LIMITS = {
  FREE: { projects: 3, messagesPerDay: 20, proposalsPerDay: 5 },
  PRO: { projects: Number.POSITIVE_INFINITY, messagesPerDay: Number.POSITIVE_INFINITY, proposalsPerDay: Number.POSITIVE_INFINITY },
} as const;

export type Plan = 'FREE' | 'PRO';

export function getPlan(user: User): Plan {
  const plan = user.app_metadata?.plan ?? user.user_metadata?.plan;
  return String(plan).toLowerCase() === 'pro' ? 'PRO' : 'FREE';
}

export function getLimits(user: User) {
  return LIMITS[getPlan(user)];
}

export function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function getUsage(supabase: SupabaseClient, userId: string, date = utcDate()) {
  const { data, error } = await supabase
    .from('user_usage')
    .select('user_id,message_count,proposal_count,date')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? { user_id: userId, message_count: 0, proposal_count: 0, date };
}

export async function checkUsageLimit(
  supabase: SupabaseClient,
  user: User,
  kind: 'message' | 'proposal',
) {
  const limits = getLimits(user);
  if (limits[`${kind}sPerDay` as 'messagesPerDay' | 'proposalsPerDay'] === Number.POSITIVE_INFINITY) {
    return { allowed: true, usage: await getUsage(supabase, user.id), limit: Number.POSITIVE_INFINITY, plan: getPlan(user) };
  }
  const usage = await getUsage(supabase, user.id);
  const count = kind === 'message' ? usage.message_count : usage.proposal_count;
  const limit = kind === 'message' ? limits.messagesPerDay : limits.proposalsPerDay;
  return { allowed: count < limit, usage, limit, plan: getPlan(user) };
}

export async function incrementUsage(supabase: SupabaseClient, userId: string, kind: 'message' | 'proposal') {
  const date = utcDate();
  const usage = await getUsage(supabase, userId, date);
  const next = {
    user_id: userId,
    date,
    message_count: usage.message_count + (kind === 'message' ? 1 : 0),
    proposal_count: usage.proposal_count + (kind === 'proposal' ? 1 : 0),
  };
  const { error } = await supabase.from('user_usage').upsert(next, { onConflict: 'user_id,date' });
  if (error) throw new Error(error.message);
  return next;
}

export async function getProjectCount(supabase: SupabaseClient, userId: string) {
  const { count, error } = await supabase.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
