import { Workspace } from "@/components/workspace";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <main style={{padding:40,fontFamily:"system-ui"}}><h1>Nexa Code AI</h1><p>Sign in to open your coding workspace.</p><a href="/login">Continue to login</a></main>;
  const { data: projects } = await supabase.from("projects").select("*").eq("owner_id", user.id).order("updated_at", { ascending: false });
  return <Workspace initialProjects={projects ?? []} />;
}
