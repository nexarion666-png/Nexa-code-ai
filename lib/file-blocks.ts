/** Parse Nexa's generated-file response format without accepting arbitrary prose as code. */
export type GeneratedFileBlock = { path: string; content: string };

const MARKER = /(?:^|\r?\n)[ \t]*---[ \t]*FILE[ \t]*:[ \t]*([^\r\n]+?)[ \t]*---[ \t]*(?:\r?\n)?/gim;

function safePath(rawPath: string): string | null {
  const trimmedPath = rawPath.trim().replace(/^['"]|['"]$/g, '');
  if (trimmedPath.startsWith('/')) return null;
  const filePath = trimmedPath.replace(/^\.\//, '');
  if (!filePath || filePath.includes('\\') || filePath.split('/').some(part => part === '..' || part === '.')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePath) || filePath.includes('\0')) return null;
  return filePath;
}

function cleanContent(raw: string): string {
  let content = raw.replace(/^\s*```[\w.+-]*\s*\r?\n/, '');
  content = content.replace(/\r?\n\s*```\s*$/, '');
  return content.replace(/\s+$/, '') + (content.trim() ? '\n' : '');
}

export function parseGeneratedFileBlocks(response: string, fallbackPath?: string): GeneratedFileBlock[] {
  const text = response.replace(/^\uFEFF/, '').trim();
  if (!text) return [];

  const byPath = new Map<string, GeneratedFileBlock>();
  const markers = [...text.matchAll(MARKER)];
  for (let index = 0; index < markers.length; index++) {
    const match = markers[index];
    const path = safePath(match[1]);
    if (!path) continue;
    const start = match.index + match[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const content = cleanContent(text.slice(start, end));
    if (content.trim()) byPath.set(path, { path, content });
  }
  if (byPath.size) return [...byPath.values()];

  // Some providers wrap structured output as JSON despite the explicit file-block instruction.
  // Accept only a strict array/object shape with explicit path and string content fields.
  const jsonCandidate = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (jsonCandidate.startsWith('{') || jsonCandidate.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(jsonCandidate);
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)
          ? (parsed as { files: unknown[] }).files
          : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as { path?: unknown; content?: unknown };
        if (typeof candidate.path !== 'string' || typeof candidate.content !== 'string') continue;
        const path = safePath(candidate.path);
        if (path && candidate.content.trim()) byPath.set(path, { path, content: cleanContent(candidate.content) });
      }
      if (byPath.size) return [...byPath.values()];
    } catch { /* Invalid JSON is handled as an unparseable provider response. */ }
  }

  // Repair-only compatibility: if a single target file is known, accept exactly one fenced
  // code block as a full replacement. Never use this fallback during initial generation.
  if (fallbackPath) {
    const path = safePath(fallbackPath);
    const fences = [...text.matchAll(/```([\w.+-]*)\s*\r?\n([\s\S]*?)\r?\n```/g)];
    if (path && fences.length === 1) {
      const content = cleanContent(fences[0][2]);
      if (content.trim()) return [{ path, content }];
    }
  }

  return [];
}
