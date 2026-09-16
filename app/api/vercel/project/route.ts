import { NextResponse } from "next/server";
import { getVercelProject } from "@/lib/vercel";

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  if (!process.env.VERCEL_TOKEN) return NextResponse.json({ error: "VERCEL_TOKEN is not configured." }, { status: 503 });

  try {
    return NextResponse.json(await getVercelProject(projectId, process.env.VERCEL_TOKEN));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Vercel request failed." }, { status: 502 });
  }
}
