import type {
  ActivityPage,
  ApiToken,
  ApplyResult,
  AssistantChange,
  AssistantStatus,
  ChatStreamEvent,
  PrioritySuggestion,
  CreatedToken,
  CreateProjectInput,
  CreateTokenInput,
  CreateTaskInput,
  DoneLogPage,
  MoveProjectInput,
  PushSubscriptionInput,
  SetAgentStateInput,
  StartTimerInput,
  Timer,
  MoveTaskInput,
  Project,
  Task,
  UpdateProjectInput,
  UpdateTaskInput,
  VoiceParseResult,
  VoiceStatus,
} from '@helm/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `body` is sent as JSON, except a Blob, which goes as is with its own type (audio). */
/** Tells the server which day "today" is here (see `timeZoneOf` on the server). */
const ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
})();

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  const raw = body instanceof Blob;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(ZONE ? { 'x-time-zone': ZONE } : {}),
        ...(body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' }),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'unreachable', 'Can’t reach Helm. Check your connection and try again.');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? res.statusText);
  }
  return data as T;
}

export interface DoneQuery {
  projectId?: string;
  from?: string;
  to?: string;
  includeSubtasks?: boolean;
  limit?: number;
  cursor?: string;
}

function queryString(q: object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export type TaskAction = 'start' | 'stop' | 'complete' | 'reopen' | 'restore';

export interface ActivityQuery {
  who?: 'all' | 'agents';
  taskId?: string;
  limit?: number;
  cursor?: number;
}

/** The device's time zone, so the server's idea of "today" matches the user's. */
const tzQuery = () => queryString({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone });

/** Lines of an NDJSON response as parsed objects. */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
    if (done) return;
  }
}

async function* chatStream(messages: { role: 'user' | 'assistant'; content: string }[], signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`/api/v1/assistant/chat${tzQuery()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'unreachable', 'Can’t reach Helm. Check your connection and try again.');
  }
  if (!res.ok || !res.body) {
    const err = res.headers.get('content-type')?.includes('json') ? ((await res.json()).error ?? {}) : {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? res.statusText);
  }
  yield* readNdjson<ChatStreamEvent>(res.body);
}

export const api = {
  me: () => request<{ signedIn: boolean }>('GET', '/auth/me'),
  login: (password: string) => request<{ ok: true }>('POST', '/auth/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),

  tasks: () => request<Task[]>('GET', '/tasks'),
  createTask: (input: CreateTaskInput) => request<Task>('POST', '/tasks', input),
  updateTask: (id: string, patch: UpdateTaskInput) => request<Task>('PATCH', `/tasks/${id}`, patch),
  deleteTask: (id: string) => request<Task>('DELETE', `/tasks/${id}`),
  taskAction: (id: string, action: TaskAction) => request<Task>('POST', `/tasks/${id}/${action}`),
  moveTask: (id: string, input: MoveTaskInput) => request<Task>('POST', `/tasks/${id}/move`, input),
  setAgentState: (id: string, input: SetAgentStateInput) => request<Task>('POST', `/tasks/${id}/agent`, input),
  done: (q: DoneQuery) => request<DoneLogPage>('GET', `/done${queryString(q)}`),
  activity: (q: ActivityQuery) => request<ActivityPage>('GET', `/activity${queryString(q)}`),
  undo: (batchId: string) => request<{ ok: true }>('POST', `/activity/${encodeURIComponent(batchId)}/undo`),

  /** Archived ones too, so the Done log can still name them. */
  projects: () => request<Project[]>('GET', '/projects?includeArchived=true'),
  createProject: (input: CreateProjectInput) => request<Project>('POST', '/projects', input),
  updateProject: (id: string, patch: UpdateProjectInput) => request<Project>('PATCH', `/projects/${id}`, patch),
  moveProject: (id: string, input: MoveProjectInput) => request<Project>('POST', `/projects/${id}/move`, input),
  archiveProject: (id: string) => request<Project>('DELETE', `/projects/${id}`),
  deleteProject: (id: string) => request<Project>('DELETE', `/projects/${id}?permanent=true`),

  timer: () => request<{ timer: Timer | null }>('GET', '/timer').then((r) => r.timer),
  startTimer: (input: StartTimerInput) => request<Timer>('POST', '/timer', input),
  pauseTimer: () => request<Timer>('POST', '/timer/pause'),
  resumeTimer: () => request<Timer>('POST', '/timer/resume'),
  extendTimer: (minutes: number) => request<Timer>('POST', '/timer/extend', { minutes }),
  stopTimer: () => request<Timer>('DELETE', '/timer'),
  pushKey: () => request<{ publicKey: string }>('GET', '/push/key'),
  subscribePush: (sub: PushSubscriptionInput) => request<{ ok: true }>('POST', '/push/subscriptions', sub),
  unsubscribePush: (endpoint: string) => request<{ ok: true }>('DELETE', '/push/subscriptions', { endpoint }),
  testPush: () => request<{ sent: number; failed: number }>('POST', '/push/test'),

  tokens: () => request<ApiToken[]>('GET', '/tokens'),
  createToken: (input: CreateTokenInput) => request<CreatedToken>('POST', '/tokens', input),
  revokeToken: (id: string) => request<ApiToken>('DELETE', `/tokens/${id}`),

  assistantStatus: () => request<AssistantStatus>('GET', '/assistant'),
  prioritize: (signal?: AbortSignal) =>
    request<PrioritySuggestion>('POST', `/assistant/prioritize${tzQuery()}`, {}, signal),
  applyChanges: (changes: AssistantChange[]) => request<ApplyResult>('POST', '/assistant/apply', { changes }),
  chat: chatStream,

  voiceStatus: () => request<VoiceStatus>('GET', '/voice'),
  /** Audio from the recorder, or text from the browser's own speech recognition. */
  voiceParse: (input: Blob | string, signal?: AbortSignal) =>
    request<VoiceParseResult>(
      'POST',
      `/voice/parse${tzQuery()}`,
      typeof input === 'string' ? { text: input } : input,
      signal,
    ),
};
