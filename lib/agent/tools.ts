export type AgentToolName =
  | "create_file"
  | "read_file"
  | "update_file"
  | "delete_file"
  | "list_files"
  | "save_memory"
  | "search_memory"
  | "create_github_commit";

export type AgentTool = {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const tools: AgentTool[] = [
  { name: "create_file", description: "Create a file in the active project.", inputSchema: { path: "string", content: "string" } },
  { name: "read_file", description: "Read a project file.", inputSchema: { path: "string" } },
  { name: "update_file", description: "Replace or patch a project file.", inputSchema: { path: "string", content: "string" } },
  { name: "delete_file", description: "Delete a project file.", inputSchema: { path: "string" } },
  { name: "list_files", description: "List project files.", inputSchema: {} },
  { name: "save_memory", description: "Save durable project context or a decision.", inputSchema: { content: "string", type: "string" } },
  { name: "search_memory", description: "Search durable project context.", inputSchema: { query: "string" } },
  { name: "create_github_commit", description: "Commit project changes to GitHub.", inputSchema: { repository: "string", message: "string" } }
];
