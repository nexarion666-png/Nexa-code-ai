/** Select a focused, bounded set of real project files for an AI request. */
export type ProjectContextFile = { path: string; content: string | null };

const STOP_WORDS = new Set([
  'about','after','again','also','and','any','are','because','before','build','can','change','code','could','create','does','file','fix','for','from','give','have','help','into','make','need','not','please','project','should','that','the','their','them','there','this','want','what','when','where','with','would',
]);

function words(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []).filter(word => !STOP_WORDS.has(word)))];
}

/**
 * Rank paths and contents against the current request. Always prioritize project
 * manifests and entry points, then fill the remaining budget with relevant files.
 * This is a heuristic, not a substitute for checking imports or fetching more files.
 */
export function selectProjectContext<T extends ProjectContextFile>(
  files: T[],
  requestText: string,
  options: { maxChars?: number; maxFiles?: number; perFileChars?: number } = {},
): T[] {
  const maxChars = options.maxChars ?? 18000;
  const maxFiles = options.maxFiles ?? 16;
  const perFileChars = options.perFileChars ?? 5000;
  const terms = words(requestText);
  const important = /^(package\.json|tsconfig\.json|next\.config\.[^/]+|app\/(layout|page)\.[^/]+|src\/(app|pages)\/(layout|page)\.[^/]+|app\/globals\.css)$/;
  const ranked = files.map((file, index) => {
    const path = file.path.replace(/^\.\//, '');
    const pathLower = path.toLowerCase();
    const content = file.content ?? '';
    let score = important.test(path) ? 18 : 0;
    for (const term of terms) {
      if (pathLower.includes(term)) score += 8;
      const hits = content.toLowerCase().split(term).length - 1;
      score += Math.min(hits, 4) * 1.5;
    }
    // Core app and shared component files are useful baseline context.
    if (/(^|\/)(components|lib|hooks|utils|types)(\/|$)/i.test(path)) score += 2;
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock)$/i.test(path)) score -= 30;
    return { file, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const selected: T[] = [];
  let used = 0;
  for (const item of ranked) {
    if (selected.length >= maxFiles || used >= maxChars) break;
    const content = item.file.content ?? '';
    const cost = Math.min(content.length, perFileChars) + item.file.path.length + 30;
    if (selected.length && used + cost > maxChars) continue;
    selected.push(item.file);
    used += cost;
  }
  return selected;
}

export function formatProjectContext(files: ProjectContextFile[], requestText: string, options: { maxChars?: number; maxFiles?: number; perFileChars?: number } = {}): string {
  if (!files.length) return '\n\nNo saved project files were found yet. This may be a new project.';
  const selected = selectProjectContext(files, requestText, options);
  const perFileChars = options.perFileChars ?? 5000;
  const omitted = files.length - selected.length;
  return `\n\nRelevant existing project files (${selected.length} of ${files.length}; file contents may be truncated). Use these actual files as the source of truth. If a required file is not shown, do not invent its current contents; request/retrieve it before proposing a modification.\n${selected.map(file => `---EXISTING FILE: ${file.path}---\n${(file.content ?? '').slice(0, perFileChars)}`).join('\n\n')}${omitted > 0 ? `\n\n[${omitted} additional project files were not included in this context window.]` : ''}`;
}
