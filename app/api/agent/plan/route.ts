import { NextResponse } from "next/server";
import { planProjectChange } from "@/lib/agent/planner";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const request = typeof body.request === "string" ? body.request.trim() : "";
    const files = Array.isArray(body.files) ? body.files : [];
    const projectMemory = Array.isArray(body.projectMemory) ? body.projectMemory : [];

    if (!request) {
      return NextResponse.json({ error: "A coding request is required." }, { status: 400 });
    }

    const plan = await planProjectChange({ request, files, projectMemory });
    return NextResponse.json(plan);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent planning failed." },
      { status: 500 }
    );
  }
}
