export type ProjectFile = { path: string; content: string };
export type AgentAction =
  | { type: 'create_file'; path: string; content: string }
  | { type: 'update_file'; path: string; content: string }
  | { type: 'delete_file'; path: string }
  | { type: 'save_memory'; memoryType: 'decision' | 'context' | 'preference'; content: string };
export type AgentPlan = { summary: string; actions: AgentAction[]; notes: string[] };

export type ValidationIssue = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type VerificationResult = {
  phase: 'static' | 'build' | 'unsupported';
  ok: boolean;
  staticValidation: ValidationResult;
  build: {
    attempted: boolean;
    passed: boolean;
    command?: string;
    output?: string;
    reason?: string;
  };
};
