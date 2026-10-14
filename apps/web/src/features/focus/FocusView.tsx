import { useMemo } from 'react';
import { buildTree, computeFocus, dayKey } from '@helm/shared';
import { useProjects, useTaskAction, useTasks } from '../../lib/queries.ts';
import { useCompleteTask } from '../../lib/useCompleteTask.ts';
import { useNow } from '../../lib/useNow.ts';
import type { ProjectMap } from '../../ui/ProjectLabel.tsx';
import { useEditor } from '../task-editor/EditorContext.tsx';
import { useFocusLayout } from './focus-layout.ts';
import { FocusCompass, FocusOne, FocusVital, type LayoutProps } from './FocusLayouts.tsx';
import './focus.css';

export function FocusView() {
  const tasks = useTasks();
  const projects = useProjects();
  const action = useTaskAction();
  const editor = useEditor();
  const complete = useCompleteTask();
  const now = useNow(30_000);
  const layout = useFocusLayout();

  const today = dayKey(new Date(now));
  const focus = useMemo(() => computeFocus(tasks.data ?? [], today), [tasks.data, today]);
  const openCount = useMemo(
    () => buildTree(tasks.data ?? []).filter((t) => t.status !== 'done').length,
    [tasks.data],
  );
  const projectMap: ProjectMap = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  if (tasks.isPending) return <main className="focus" aria-busy="true" />;
  if (tasks.isError) {
    return (
      <main className="focus focus-message">
        <p>Couldn’t load tasks: {tasks.error.message}</p>
      </main>
    );
  }

  const props: LayoutProps = {
    focus,
    projects: projectMap,
    now,
    openCount,
    run: (id, a) => action.mutate({ id, action: a }),
    onEdit: (id) => editor.openEdit(id),
    onComplete: (t) => void complete(t),
    onAdd: () => editor.openCreate({ priority: 'now' }),
  };
  if (layout === 'vital') return <FocusVital {...props} />;
  if (layout === 'compass') return <FocusCompass {...props} />;
  return <FocusOne {...props} />;
}
