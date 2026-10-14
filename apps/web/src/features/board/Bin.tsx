import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useState, type CSSProperties, type MouseEvent } from 'react';
import { PRIORITIES, type Priority, type Project, type TaskNode } from '@helm/shared';
import { formatMinutes } from '../../lib/format.ts';
import { binDropId, containerId } from './board-model.ts';
import { projectIcon } from './project-icon.ts';
import { QuickAdd } from './QuickAdd.tsx';
import { SortableTaskCard, type CardActions } from './TaskCard.tsx';

const PRIORITY_LABEL: Record<Priority, string> = { now: 'Now', soon: 'Soon', someday: 'Someday' };
/** A panel shows this many tasks, then "Show N more": no scroll box inside the page's scroll. */
const SHOW_FIRST = 10;

interface BinProps extends CardActions {
  bin: string;
  /** null for the Inbox. */
  project: Project | null;
  /** All live projects, for `#name` in quick add. */
  projects: Project[];
  /** Task ids per priority, in display order. */
  groups: Record<Priority, string[]>;
  nodes: Map<string, TaskNode>;
  collapsed: boolean;
  dragging: boolean;
  /** The task being dragged, always shown so it never disappears under the fold. */
  activeId: string | null;
  onToggleCollapsed: () => void;
  onAdd: (priority?: Priority) => void;
  onEditProject?: () => void;
}

export function Bin(props: BinProps) {
  const { bin, project, groups, nodes, collapsed, dragging, activeId } = props;
  const [expanded, setExpanded] = useState(false);
  // Added here with quick add: kept in view even past the first ten, so you see it land.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const ids = PRIORITIES.flatMap((p) => groups[p]);
  const shown = new Set(expanded ? ids : ids.filter((id, i) => i < SHOW_FIRST || id === activeId || added.has(id)));
  const hidden = ids.length - shown.size;
  const minutes = ids.reduce((sum, id) => sum + (nodes.get(id)?.estimateMinutes ?? 0), 0);
  const name = project?.name ?? 'Inbox';
  const header = useDroppable({ id: binDropId(bin), disabled: !collapsed });
  const bodyId = `bin-body-${bin}`;
  const icon = projectIcon(project);

  // Double-click (or double-tap) the header or empty space to fold the panel; not on tasks or buttons.
  const onDoubleClick = (e: MouseEvent) => {
    if ((e.target as Element).closest('button, a, input, select, textarea, .card')) return;
    window.getSelection()?.removeAllRanges();
    props.onToggleCollapsed();
  };

  return (
    <section
      id={`bin-${bin}`}
      className={`bin ${collapsed ? 'is-collapsed' : ''} ${header.isOver ? 'is-drop-target' : ''} ${project ? '' : 'is-inbox'}`}
      style={project ? ({ '--bin': project.color } as CSSProperties) : undefined}
      aria-label={name}
      onDoubleClick={onDoubleClick}
    >
      <header className="bin-head" ref={header.setNodeRef}>
        <button
          className="bin-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          title="Collapse or expand (or double-click the panel)"
          onClick={props.onToggleCollapsed}
        >
          <span className="bin-chevron" aria-hidden="true" />
        </button>
        {icon && (
          <span className="bin-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <h2 className="bin-name">{name}</h2>
        <span className="bin-stats">
          {/* The count is on the tab too, so phones show only the time and keep room for the name. */}
          <span className={minutes > 0 ? 'bin-stats-count' : undefined}>
            {ids.length} {ids.length === 1 ? 'task' : 'tasks'}
            {minutes > 0 && ', '}
          </span>
          {minutes > 0 && formatMinutes(minutes)}
        </span>
        <span className="bin-tools">
          <button className="icon-btn" aria-label={`Add task to ${name}`} onClick={() => props.onAdd()}>
            +
          </button>
          {props.onEditProject && (
            <button className="icon-btn" aria-label={`Edit project ${name}`} onClick={props.onEditProject}>
              …
            </button>
          )}
        </span>
      </header>

      {!collapsed && (
        <div className="bin-body" id={bodyId}>
          <QuickAdd
            projectId={project?.id ?? null}
            name={name}
            projects={props.projects}
            onAdded={(t) => setAdded((a) => new Set(a).add(t.id))}
          />
          {ids.length === 0 && !dragging ? (
            <p className="bin-empty">Nothing here yet.</p>
          ) : (
            PRIORITIES.map((p) => {
              const visible = groups[p].filter((id) => shown.has(id));
              return visible.length > 0 || dragging ? (
                <Group
                  key={p}
                  id={containerId(bin, p)}
                  priority={p}
                  ids={visible}
                  total={groups[p].length}
                  {...props}
                />
              ) : null;
            })
          )}
          {(hidden > 0 || expanded) && ids.length > SHOW_FIRST && (
            <button className="bin-more" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
              {expanded ? 'Show less' : `Show ${hidden} more`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Group({
  id,
  priority,
  ids,
  total,
  nodes,
  ...actions
}: BinProps & { id: string; priority: Priority; ids: string[]; total: number }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className={`group ${ids.length === 0 ? 'is-empty' : ''} ${isOver ? 'is-over' : ''}`}>
      <h3 className={`group-label group-label-${priority}`}>
        {PRIORITY_LABEL[priority]}
        {total > 0 && <span className="group-count">{total}</span>}
      </h3>
      <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
        <ul className="group-list" ref={setNodeRef}>
          {ids.map((taskId) => {
            const node = nodes.get(taskId);
            return node ? (
              <SortableTaskCard
                key={taskId}
                task={node}
                onEdit={actions.onEdit}
                onComplete={actions.onComplete}
                onToggleSubtask={actions.onToggleSubtask}
                onToggleWork={actions.onToggleWork}
                onToggleToday={actions.onToggleToday}
                today={actions.today}
              />
            ) : null;
          })}
        </ul>
      </SortableContext>
    </div>
  );
}
