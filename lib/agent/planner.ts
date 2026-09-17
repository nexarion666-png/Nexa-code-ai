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

export async function planProjectChange(input: { request: string; image?: { mimeType: string; data: string }; files: ProjectFile[]; projectMemory: string[]; conversation?: string[]; iteration?: number }): Promise<AgentPlan> {
  const gateway = await createGatewayForUser();
  const fileContext = input.files.map(f => `FILE: ${f.path}\n${f.content}`).join('\n\n').slice(0, 180000);
  const memory = input.projectMemory.map(x => `- ${x}`).join('\n').slice(0, 20000);
  const conversation = (input.conversation ?? []).join('\n').slice(-30000);
  const prompt = `You are Nexa Code AI, an autonomous software engineer. This is iteration ${input.iteration ?? 1} of a bounded multi-step task. Return ONLY valid JSON matching {"summary":"short summary","actions":[{"type":"create_file|update_file","path":"...","content":"..."},{"type":"delete_file","path":"..."},{"type":"save_memory","memoryType":"decision|context|preference","content":"..."}],"notes":["..."]}.

Treat the request as a real software deliverable, not a request for a few illustrative files. Inspect the existing project before changing it and preserve unrelated behavior. For a new website, generate the complete experience appropriate to the request: routes/pages, layout and navigation, a strong hero, at least three substantive content sections, meaningful components, responsive visual hierarchy, interactions or state where useful, clear calls to action, and footer/contact details. For a dealership, for example, include inventory or vehicle cards, financing or buying information, trust/service content, and a contact or test-drive path. Do not add arbitrary features just to increase file count; choose completeness from the user's domain.

Before returning a plan, reconcile the entire proposed project:
- Every imported package must be declared in package.json.
- Every local import, referenced component, route, image, font, and other local asset must exist in the existing files or in this plan.
- Keep package.json, its lockfile when present, framework config, tsconfig, CSS, and component code consistent.
- If Tailwind is used, inspect its declared version. Tailwind v3 requires compatible @tailwind directives, a Tailwind config with content paths covering the source directories, and a PostCSS config. Tailwind v4 requires its v4-compatible CSS/configuration. Never mix the two.
- If a CSS framework is not needed, use plain CSS or the styling system already present rather than forcing Tailwind.
- Do not invent remote assets that are likely to fail; use existing assets, safe local placeholders, CSS, or stable external URLs only when the project is configured to use them.
- Include the dependency/configuration files required for the chosen framework. A website is not complete when the page code exists but its build setup does not.

For a repair iteration, use the actual verification failure below as the primary diagnosis. Make the smallest coherent correction, then re-check imports, dependencies, assets, and configuration. Never claim that code was executed or tested. Never create secrets, arbitrary shell commands, absolute paths, or path traversal. If the request is already satisfied and no repair is needed, return an empty actions array.

USER REQUEST:
${input.request}

CONVERSATION HISTORY:
${conversation || 'None'}

MEMORY:
${memory || 'None'}

CURRENT FILES:
${fileContext || 'No files.'}`;
  const result = await gateway.complete({
    system: 'You are the planning engine for Nexa Code AI. Be honest, precise, and practical. Produce internally consistent, buildable project plans.',
    user: prompt,
    image: input.image,
  });
  const parsed = Plan.safeParse(JSON.parse(extractJson(result.text)));
  if (parsed.success) {
    console.log('AGENT_PLAN_RESULT', {
      provider: result.provider,
      summary: parsed.data.summary,
      actionCount: parsed.data.actions.length,
      actions: parsed.data.actions.map((action) => ({
        type: action.type,
        path: 'path' in action ? action.path : undefined,
      })),
    });
    return parsed.data as AgentPlan;
  }
  return { summary: 'The AI produced an invalid plan format.', actions: [], notes: [`Provider response could not be validated as JSON: ${result.provider}`] };
}
