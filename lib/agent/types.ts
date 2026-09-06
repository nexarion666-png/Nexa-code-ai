export type ProjectFile = { path: string; content: string };
export type AgentAction =
  | { type: 'create_file'; path: string; content: string }
  | { type: 'update_file'; path: string; content: string }
  | { type: 'delete_file'; path: string }
  | { type: 'save_memory'; memoryType: 'decision' | 'context' | 'preference'; content: string };
export type AgentPlan = { summary: string; actions: AgentAction[]; notes: string[] };
