import { sql } from './db.js';

export interface AuditTaskStart {
  taskId: string;
  tenantId: string;
  userId?: string;
  appName?: string;
  taskDescription: string;
  browserMode: string;
}

export interface AuditStep {
  taskId: string;
  tenantId: string;
  stepNum: number;
  action?: string;
  thinking?: string;
  inputMode?: string;
  browserMode?: string;
  tokensInput?: number;
  tokensOutput?: number;
}

export interface AuditTaskEnd {
  taskId: string;
  tenantId: string;
  stepNum: number;
  status: 'completed' | 'failed' | 'cancelled';
  totalTokensInput: number;
  totalTokensOutput: number;
  error?: string;
}

export async function recordTaskStart(e: AuditTaskStart): Promise<void> {
  await sql`
    INSERT INTO cu_audit (task_id, tenant_id, user_id, step_num, event_type, app_name, task_description, browser_mode)
    VALUES (${e.taskId}, ${e.tenantId}, ${e.userId ?? null}, 0, 'task_start', ${e.appName ?? null}, ${e.taskDescription}, ${e.browserMode})
  `;
}

export async function recordStep(e: AuditStep): Promise<void> {
  await sql`
    INSERT INTO cu_audit (task_id, tenant_id, step_num, event_type, action, thinking, input_mode, browser_mode, tokens_input, tokens_output)
    VALUES (${e.taskId}, ${e.tenantId}, ${e.stepNum}, 'step', ${e.action ?? null}, ${e.thinking ?? null}, ${e.inputMode ?? null}, ${e.browserMode ?? null}, ${e.tokensInput ?? null}, ${e.tokensOutput ?? null})
  `;
}

export async function recordTaskEnd(e: AuditTaskEnd): Promise<void> {
  await sql`
    INSERT INTO cu_audit (task_id, tenant_id, step_num, event_type, status, tokens_input, tokens_output, error)
    VALUES (${e.taskId}, ${e.tenantId}, ${e.stepNum}, 'task_end', ${e.status}, ${e.totalTokensInput}, ${e.totalTokensOutput}, ${e.error ?? null})
  `;
}
