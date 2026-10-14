import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ApiToken,
  DoneLogPage,
  MoveProjectInput,
  MoveTaskInput,
  Project,
  Task,
  Timer,
  TodaySlot,
  UpdateProjectInput,
} from '@helm/shared';
import { api, type ActivityQuery, type DoneQuery, type TaskAction } from './api.ts';

export const keys = {
  me: ['me'] as const,
  tasks: ['tasks'] as const,
  projects: ['projects'] as const,
  done: ['done'] as const,
  tokens: ['tokens'] as const,
  voice: ['voice'] as const,
  assistant: ['assistant'] as const,
  timer: ['timer'] as const,
  activity: ['activity'] as const,
};

/** Queries kept on the device so the app opens with the last snapshot, even offline. */
export const PERSISTED_KEYS: readonly string[] = [keys.me[0], keys.tasks[0], keys.projects[0]];

/** Signed out or session expired: drop everything cached about the board (and its persisted copy). */
export function clearUserData(qc: QueryClient) {
  for (const key of [keys.tasks, keys.projects, keys.done, keys.tokens, keys.timer, keys.activity]) {
    qc.removeQueries({ queryKey: key });
  }
}

export const useTasks = () => useQuery({ queryKey: keys.tasks, queryFn: api.tasks });
/** Board order. Live events and moves update the cache in place, so sort here rather than trust list order. */
const byPosition = (a: Project, b: Project) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const liveProjects = (ps: Project[]) => ps.filter((p) => !p.archivedAt).sort(byPosition);
/** Active projects. Archived ones stay in the cache (live events upsert them) but are filtered out here. */
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.projects, select: liveProjects });
/** Including archived projects (for labelling old tasks). */
export const useAllProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.projects });

const DONE_PAGE = 100;

/** Done log, newest first, loaded a page at a time. */
export function useDoneLog(query: Omit<DoneQuery, 'cursor' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: [...keys.done, query],
    queryFn: ({ pageParam }) => api.done({ ...query, limit: DONE_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Who changed what, newest first, a page at a time. Live events refresh it (see `refreshActivity`). */
export function useActivity(query: Omit<ActivityQuery, 'cursor' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: [...keys.activity, query],
    queryFn: ({ pageParam }) => api.activity({ ...query, limit: 30, cursor: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

const activityRefresh = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/** One request can emit many events; refetch the activity log once after the burst. */
export function refreshActivity(qc: QueryClient) {
  clearTimeout(activityRefresh.get(qc));
  activityRefresh.set(
    qc,
    setTimeout(() => void qc.invalidateQueries({ queryKey: keys.activity }), 250),
  );
}

export function useUndo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.undo,
    // Live events bring the restored tasks; this makes sure the log shows it as undone.
    onSettled: () => refreshActivity(qc),
  });
}

export function useSetAgentState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof api.setAgentState>[1]) => api.setAgentState(id, input),
    onSuccess: (task) => upsertTask(qc, task),
  });
}

function inDoneLog(qc: QueryClient, id: string): boolean {
  return qc
    .getQueriesData<InfiniteData<DoneLogPage>>({ queryKey: keys.done })
    .some(([, data]) => data?.pages.some((pg) => pg.tasks.some((t) => t.id === id)));
}

const doneRefresh = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/** Completing a parent emits one event per subtask; refetch the log once after the burst. */
function refreshDoneLog(qc: QueryClient) {
  clearTimeout(doneRefresh.get(qc));
  doneRefresh.set(
    qc,
    setTimeout(() => void qc.invalidateQueries({ queryKey: keys.done }), 150),
  );
}

/** Insert or replace an entity in a cached list (used by mutations and live events). */
export function upsert<T extends { id: string; updatedAt: string }>(qc: QueryClient, key: readonly unknown[], item: T) {
  qc.setQueryData<T[]>(key, (list) => {
    if (!list) return list;
    const i = list.findIndex((x) => x.id === item.id);
    if (i === -1) return [...list, item];
    // Ignore stale snapshots (e.g. a late HTTP response after a newer live event).
    if (list[i]!.updatedAt > item.updatedAt) return list;
    const next = list.slice();
    next[i] = item;
    return next;
  });
}

export function upsertTask(qc: QueryClient, task: Task) {
  upsert(qc, keys.tasks, task);
  // Entered or left the log (or changed while in it).
  if (task.status === 'done' || inDoneLog(qc, task.id)) refreshDoneLog(qc);
}

export function upsertProject(qc: QueryClient, project: Project) {
  upsert(qc, keys.projects, project);
}

/** A project deleted for good: drop it, and refetch tasks (its tasks were deleted with it). */
export function removeProject(qc: QueryClient, id: string) {
  qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== id));
  void qc.invalidateQueries({ queryKey: keys.tasks });
  void qc.invalidateQueries({ queryKey: keys.done });
}

/** "Last used" changes without a live event, so refresh while the list is on screen. */
/** Changes only when the server restarts with other settings. */
export const useAssistantStatus = () =>
  useQuery({ queryKey: keys.assistant, queryFn: api.assistantStatus, staleTime: 5 * 60_000 });

/** Changes only when the server restarts with other settings. */
export const useVoiceStatus = () => useQuery({ queryKey: keys.voice, queryFn: api.voiceStatus, staleTime: 5 * 60_000 });

export const useTokens = () =>
  useQuery({ queryKey: keys.tokens, queryFn: api.tokens, staleTime: 0, refetchInterval: 60_000 });

/** Tokens have no updatedAt; a revoke only ever moves forward, so replace in place. */
export function upsertToken(qc: QueryClient, token: ApiToken) {
  qc.setQueryData<ApiToken[]>(keys.tokens, (list) => {
    if (!list) return list;
    const i = list.findIndex((t) => t.id === token.id);
    if (i === -1) return [token, ...list];
    if (list[i]!.revokedAt && !token.revokedAt) return list;
    const next = list.slice();
    next[i] = token;
    return next;
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createToken,
    onSuccess: ({ token }) => upsertToken(qc, token),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.revokeToken,
    onSuccess: (token) => upsertToken(qc, token),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createProject,
    onSuccess: (p) => upsertProject(qc, p),
  });
}

export function useTaskAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: TaskAction }) => api.taskAction(id, action),
    onSuccess: (task) => upsertTask(qc, task),
  });
}

/** Put a task on Today (main or side) or take it off (null). */
/**
 * Put a task on the plan, move it between main and side or to another day (`planDate`), or take
 * it off (`today: null`). The card moves at once; the server's answer then wins.
 */
export function useSetToday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, today, planDate }: { id: string; today?: TodaySlot | null; planDate?: string }) =>
      api.updateTask(id, { ...(today !== undefined ? { today } : {}), ...(planDate ? { planDate } : {}) }),
    onMutate: ({ id, today, planDate }) => {
      const t = qc.getQueryData<Task[]>(keys.tasks)?.find((x) => x.id === id);
      if (!t) return;
      const slot = today !== undefined ? today : (t.today ?? 'side');
      // Keeps the old updatedAt so the server response (newer) always wins.
      upsert(qc, keys.tasks, { ...t, today: slot, planDate: slot ? (planDate ?? t.planDate ?? null) : null });
    },
    onSuccess: (task) => upsertTask(qc, task),
    onError: () => qc.invalidateQueries({ queryKey: keys.tasks }),
  });
}

export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveTaskInput }) => api.moveTask(id, input),
    onSuccess: (task) => upsertTask(qc, task),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProjectInput }) => api.updateProject(id, patch),
    // Optimistic: collapse/expand should feel instant.
    onMutate: ({ id, patch }) => {
      const p = qc.getQueryData<Project[]>(keys.projects)?.find((x) => x.id === id);
      // Keep the old updatedAt so the server response (newer) always wins.
      if (p) upsertProject(qc, { ...p, ...patch });
    },
    onSuccess: (p) => upsertProject(qc, p),
    onError: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useArchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.archiveProject,
    onSuccess: (p) => {
      upsertProject(qc, p);
      // Its tasks leave the board; refetch rather than patch each one.
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}

export function useMoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveProjectInput }) => api.moveProject(id, input),
    onSuccess: (p) => upsertProject(qc, p),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteProject,
    onSuccess: (p) => removeProject(qc, p.id),
  });
}

// ---------- Timer ----------

/** The live countdown, or null. Live events keep it current on every device. */
export const useTimer = () => useQuery({ queryKey: keys.timer, queryFn: api.timer });

/** Apply a timer snapshot unless the cache already has a newer one. Ended timers clear it. */
export function setTimer(qc: QueryClient, timer: Timer) {
  qc.setQueryData<Timer | null>(keys.timer, (cur) => {
    if (cur && cur.id === timer.id && cur.updatedAt > timer.updatedAt) return cur;
    if (timer.ended) return cur && cur.id !== timer.id ? cur : null;
    return timer;
  });
}

export function useTimerAction<A>(fn: (arg: A) => Promise<Timer>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (t) => setTimer(qc, t) });
}
