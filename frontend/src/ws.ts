// Live event stream (docs/SPEC.md §8): one reconnecting WebSocket on /api/ws.
//
// The socket is a *hint* channel, not a source of truth: every message tells the UI what changed,
// and after a reconnect the store reloads from REST because events emitted while we were offline
// are gone (the bus is live-only). Backoff is capped exponential so a backend restart neither gets
// hammered nor leaves the UI disconnected for long.
import type {
  Event, IntakeItem, LLMCall, Notification, ProjectSummary, TraceEntry, Watcher,
} from './types';

interface Base {
  /** ISO timestamp stamped by the backend bus. */
  ts?: string;
}

export type WsEvent =
  | (Base & { type: 'hello'; version: string })
  | (Base & { type: 'project.updated'; project_id: string; summary: ProjectSummary })
  | (Base & { type: 'project.deleted'; project_id: string })
  | (Base & { type: 'step.trace'; project_id: string; step_id: string; entry: TraceEntry })
  | (Base & { type: 'activity'; event: Event })
  | (Base & { type: 'notification'; notification: Notification })
  | (Base & { type: 'intake.updated'; item: IntakeItem })
  | (Base & { type: 'watcher.updated'; watcher: Watcher })
  | (Base & { type: 'llm.call'; call: LLMCall })
  | (Base & { type: 'copilot.progress'; chat_id: string; text: string })
  | (Base & { type: 'settings.updated' })
  | (Base & { type: 'reference.updated'; collection: string });

export type WsEventType = WsEvent['type'];
/** The payload type of one event kind, e.g. `WsEventOf<'notification'>`. */
export type WsEventOf<T extends WsEventType> = Extract<WsEvent, { type: T }>;

export type WsStatus = 'connecting' | 'open' | 'closed';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

/** Delay before reconnect attempt n (1-based): 1 s, 2 s, 4 s, 8 s, 8 s… Pure: unit-tested. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(1, attempt));
}

/** ws(s)://<current host>/api/ws — same origin, so the Vite proxy (ws: true) and prod serving both work. */
export function wsUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/ws`;
}

export interface WsHandlers {
  onEvent: (event: WsEvent) => void;
  onStatus: (status: WsStatus) => void;
}

/** Opens the socket and keeps it open until the returned function is called. */
export function connectWS({ onEvent, onStatus }: WsHandlers): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    onStatus('connecting');
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      onStatus('open');
    };
    ws.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(msg.data));
      } catch {
        return; // not JSON: not ours
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        onEvent(parsed as WsEvent);
      }
    };
    ws.onclose = () => {
      ws = null;
      onStatus('closed');
      scheduleReconnect();
    };
    // An error is always followed by close; closing explicitly avoids half-open sockets in Safari.
    ws.onerror = () => ws?.close();
  };

  const scheduleReconnect = () => {
    if (closed) return;
    attempt += 1;
    timer = setTimeout(open, backoffDelay(attempt));
  };

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
}
