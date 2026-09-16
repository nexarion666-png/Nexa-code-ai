import { AgentAction } from './types';
export function applyActions(files: Map<string, string>, actions: AgentAction[]) {
  const changed: string[] = [], deleted: string[] = [];
  for (const action of actions) {
    if (action.type === 'create_file' || action.type === 'update_file') { files.set(action.path, action.content); changed.push(action.path); }
    if (action.type === 'delete_file') { files.delete(action.path); changed.push(action.path); deleted.push(action.path); }
  }
  return { files, changed, deleted };
}
