import { createGatewayForUser } from '@/lib/ai/gateway';
import { AgentPlan, ProjectFile } from './types';
import { z } from 'zod';

const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_file'), path: z.string(), content: z.string() }),
  z.object({ type: z.literal('update_file'), path: z.string(), content: z.string() }),
  z.object({ type: z.literal('delete_file'), path: z.string() }),
  z.object({ type: z.literal('save_memory'), memoryType: z.enum(['decision','context','preference']), content: z.string() })
]);
const Plan = z.object({ summary: z.string(), actions: z.array(Action).max(80), notes: z.array(z.string()).max(30) });
function extractJson(text: string) { const fenced = text.match(/```json\s*([\s\S]*?)```/i); if (fenced) return fenced[1]; const first = text.indexOf('{'); const last = text.lastIndexOf('}'); return first >= 0 && last > first ? text.slice(first, last + 1) : text; }

export async function planProjectChange(input: { request: string; files: ProjectFile[]; projectMemory: string[]; conversation?: string[]; iteration?: number }): Promise<AgentPlan> {
  const gateway = await createGatewayForUser();
  const fileContext = input.files.map(f => `FILE: ${f.path}\n${f.content}`).join('\n\n').slice(0, 180000);
  const memory = input.projectMemory.map(x => `- ${x}`).join('\n').slice(0, 20000);
  const conversation = (input.conversation ?? []).join('\n').slice(-30000);
  const prompt = `You are Nexa Code AI, an autonomous software engineer. This is iteration ${input.iteration ?? 1} of a bounded multi-step task. Return ONLY valid JSON matching {"summary":"short summary","actions":[{"type":"create_file|update_file","path":"...","content":"..."},{"type":"delete_file","path":"..."},{"type":"save_memory","memoryType":"decision|context|preference","content":"..."}],"notes":["..."]}. Make concrete changes, preserve unrelated code, never create secrets, and never claim code was executed or tested. If the request is already satisfied, return an empty actions array.\n\nUSER REQUEST:\n${input.request}\n\nCONVERSATION HISTORY:\n${conversation || 'None'}\n\nMEMORY:\n${memory || 'None'}\n\nCURRENT FILES:\n${fileContext || 'No files.'}`;
  const result = await gateway.complete({ system: 'You are the planning engine for Nexa Code AI. Be honest, precise, and practical.', user: prompt });
  const parsed = Plan.safeParse(JSON.parse(extractJson(result.text)));
  if (parsed.success) return parsed.data as AgentPlan;
  return { summary: 'The AI produced an invalid plan format.', actions: [], notes: [`Provider response could not be validated as JSON: ${result.provider}`] };
}
