// Props shared by every TaskPanel action area (one component per step type / pending action).
import type { Project, StepRun, TraceEntry } from '../../types';
import type { ActionRunner } from './common';

export interface ActionProps {
  project: Project;
  step: StepRun;
  /** Acting persona — sent as `user_id` with every step action. */
  userId: string;
  /** Mirror of the backend permission check for this step (the backend still decides). */
  canAct: boolean;
  /** Why the persona cannot act ('' when it can). */
  blockedReason: string;
  /** Key of the action in flight, if any. */
  busy: string | null;
  /** Runs a step action: busy state, toast, onChanged. */
  run: ActionRunner;
  /** Live trace of the step (persisted + streamed). */
  trace: TraceEntry[];
  compact?: boolean;
}
