import { NextResponse } from "next/server";
import { createGateway } from "@/lib/ai/gateway";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) return NextResponse.json({ message: "Tell me what you want to build or change." }, { status: 400 });

  const gateway = createGateway();
  const result = await gateway.complete({
    system: "You are Nexa Code AI, an honest autonomous coding assistant. Do not claim to have executed or tested code. Prefer concrete project changes and explain assumptions.",
    user: message
  });

  return NextResponse.json({ message: result.text, provider: result.provider });
}
