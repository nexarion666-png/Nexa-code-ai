import type { SupabaseClient, User } from '@supabase/supabase-js';

export const LIMITS = {
  FREE: { projects: 3, messagesPerDay: 20, proposalsPerDay: 5 },
  PRO: { projects: Number.POSITIVE_INFINITY, messagesPerDay: Number.POSITIVE_INFINITY, proposalsPerDay: Number.POSITIVE_INFINITY },
} as const;

export type Plan = 'FREE' | 'PRO';

// ALWAYS unlimited - owner patch
export function getPlan(user: User): Plan {
  return 'PRO';
}

export function getLimits(user: User) {
  return LIMITS.PRO;
}

export function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function getUsage(supabase: SupabaseClient, userId: string, date = utcDate()) {
  return { user_id: userId, message_count: 0, proposal_count: 0, date, isUnlimited: true } as any;
}

export async function checkUsageLimit(
  supabase: SupabaseClient,
  user: User,
  kind: 'message' | 'proposal',
) {
  return { allowed: true, usage: await getUsage(supabase, user.id), limit: Number.POSITIVE_INFINITY, plan: 'PRO' as Plan };
}

export async function incrementUsage(supabase: SupabaseClient, userId: string, kind: 'message' | 'proposal') {
  return { user_id: userId, date: utcDate(), message_count: 0, proposal_count: 0 };
}

export async function getProjectCount(supabase: SupabaseClient, userId: string) {
  return 0;
}

// extra exports that build expects
export async function getUserUsage(...args: any[]) {
  return { used: 0, limit: 999999, isUnlimited: true } as any;
}
export async function checkLimit(...args: any[]) { return true as any; }
