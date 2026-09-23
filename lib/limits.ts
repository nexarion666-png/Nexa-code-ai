export async function checkUsageLimit(supabase: any, userId: string) {
  return { allowed: true, remaining: 999999 };
}
export async function incrementUsage(supabase: any, userId: string, type: string) {
  return true;
}
export async function getUserUsage(supabase: any, userId: string) {
  return { proposals: 0, chats: 0, limit: 999999, isUnlimited: true };
}
