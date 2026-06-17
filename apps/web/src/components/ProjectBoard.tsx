import { useEffect, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { BacklogItem, BacklogItemType, BacklogState } from '@tractus/shared';
import { Modal } from './Modal.js';
import { api, connectWs } from '../api.js';

// --------------------------------------------------------------------------
// Column model — 5 board columns grouping the 8 internal pipeline states
// --------------------------------------------------------------------------

interface BoardColumn {
  id: string;
  label: string;
  states: BacklogState[];
  dropState: BacklogState;
  /** Agent-controlled: you can't drag cards into or out of it manually. */
  locked?: boolean;
}

const BOARD_COLUMNS: BoardColumn[] = [
  { id: 'new', label: 'New', states: ['BACKLOG'], dropState: 'BACKLOG' },
  { id: 'ready', label: 'Ready', states: ['READY'], dropState: 'READY' },
  {
    id: 'in_progress',
    label: 'In Progress',
    states: ['PLANNING', 'IN_PROGRESS', 'IN_TESTING', 'BLOCKED', 'FAILED'],
    dropState: 'IN_PROGRESS',
    locked: true,
  },
  { id: 'review', label: 'Review', states: ['PLAN_READY', 'IN_REVIEW'], dropState: 'IN_REVIEW' },
  { id: 'done', label: 'Done', states: ['DONE'], dropState: 'DONE' },
];

const isLockedColumn = (id: string): boolean =>
  BOARD_COLUMNS.find((c) => c.id === id)?.locked ?? false;

function columnForState(state: BacklogState): BoardColumn {
  return BOARD_COLUMNS.find((c) => c.states.includes(state)) ?? BOARD_COLUMNS[0];
}

function subTagForState(state: BacklogState): { label: string; variant: string } | null {
  switch (state) {
    case 'PLANNING':
      return { label: 'architect', variant: 'state' };
    case 'IN_PROGRESS':
      return { label: 'dev', variant: 'state' };
    case 'IN_TESTING':
      return { label: 'testing', variant: 'state' };
    case 'PLAN_READY':
      return { label: 'plan?', variant: 'prio' };
    case 'IN_REVIEW':
      return { label: 'merge?', variant: 'prio' };
    case 'BLOCKED':
      return { label: 'blocked', variant: 'bug' };
    case 'FAILED':
      return { label: 'failed', variant: 'bug' };
    default:
      return null;
  }
}

const TYPES: BacklogItemType[] = ['feature', 'bug'];

type Columns = Record<string, number[]>;
type ByNumber = Record<number, BacklogItem>;

/** Build the per-column ordered number lists from fetched items. */
function buildColumns(items: BacklogItem[]): { columns: Columns; byNumber: ByNumber } {
  const byNumber: ByNumber = {};
  const columns: Columns = {};
  BOARD_COLUMNS.forEach((c) => (columns[c.id] = []));
  items.forEach((i) => {
    byNumber[i.number] = i;
    columns[columnForState(i.state).id].push(i.number);
  });
  for (const c of BOARD_COLUMNS) {
    columns[c.id].sort((a, b) => {
      const pa = byNumber[a].position;
      const pb = byNumber[b].position;
      if (pa != null && pb != null) return pa - pb;
      if (pa != null) return -1;
      if (pb != null) return 1;
      return byNumber[b].updatedAt.localeCompare(byNumber[a].updatedAt);
    });
  }
  return { columns, byNumber };
}

// --------------------------------------------------------------------------
// New / Edit modals (no priority field — rank on the board is the priority)
// --------------------------------------------------------------------------

function NewItemModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (item: BacklogItem) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [type, setType] = useState<BacklogItemType>('feature');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const { item } = await api.createIssue(projectId, { title, body, type });
      onCreated(item);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <Modal title="New work item" onClose={onClose}>
      <div className="field">
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="field">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as BacklogItemType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="muted small" style={{ marginBottom: 12 }}>
        Lands in <b>New</b> — drag to rank it (order = priority).
      </div>
      {err && <div className="banner err">{err}</div>}
      <button className="btn primary" disabled={!title || busy} onClick={submit}>
        {busy ? 'creating…' : 'Create work item'}
      </button>
    </Modal>
  );
}

function EditItemModal({
  projectId,
  item,
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  item: BacklogItem;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: (number: number) => void;
}) {
  const currentCol = columnForState(item.state);
  const agentControlled = !!currentCol.locked;
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [columnId, setColumnId] = useState(currentCol.id);
  const [type, setType] = useState<BacklogItemType>(item.type);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const save = async () => {
    setBusy(true);
    setErr(undefined);
    const col = BOARD_COLUMNS.find((c) => c.id === columnId) ?? BOARD_COLUMNS[0];
    // Never push an item into a locked (agent-controlled) column from the UI.
    const targetCol = agentControlled || col.locked ? currentCol : col;
    const state = targetCol.states.includes(item.state) ? item.state : targetCol.dropState;
    try {
      await api.updateIssue(projectId, item.number, { state, type, title: title.trim(), body });
      onSaved();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const del = async () => {
    if (!window.confirm(`Delete #${item.number}? This closes the issue on GitHub.`)) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.deleteIssue(projectId, item.number);
      onDeleted(item.number);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  // Escape hatch: pull a stranded item out of the locked column back to Ready.
  const pullBackToReady = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.updateIssue(projectId, item.number, { state: 'READY' });
      onSaved();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  // Approval gates: decide the item's pending plan/merge gate.
  const approval = item.pendingApproval;
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!approval) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.decideApproval(approval.id, decision, comment.trim() || undefined);
      onSaved();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <Modal title={`#${item.number}`} onClose={onClose}>
      {item.activeAgent && (
        <div className="banner" style={{ marginBottom: 12 }}>
          <span className="pulse" /> {item.activeAgent.agentName} ({item.activeAgent.role}) is
          working on this item.
        </div>
      )}
      {approval && (
        <div className="approval-gate">
          <div className="row between" style={{ marginBottom: 6 }}>
            <b>{approval.gate === 'plan' ? 'Gate 1 · Approve plan' : 'Gate 2 · Approve merge'}</b>
            <span className="subtag prio">awaiting you</span>
          </div>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {approval.gate === 'plan'
              ? 'Approve to hand the plan to the Developer, or reject to send it back.'
              : 'Approve to merge and mark Done, or reject to send it back for changes.'}{' '}
            <a href={item.prUrl ?? item.url} target="_blank" rel="noreferrer">
              {item.prUrl ? 'review the PR ↗' : 'review on GitHub ↗'}
            </a>
          </div>
          <textarea
            rows={2}
            placeholder="Optional comment…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={() => decide('approved')}>
              ✓ Approve
            </button>
            <button className="btn danger" disabled={busy} onClick={() => decide('rejected')}>
              ✕ Reject
            </button>
          </div>
        </div>
      )}
      <div className="field">
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field grow">
          <label>Column</label>
          {agentControlled ? (
            <div className="muted small" style={{ padding: '8px 0' }}>
              <b>{currentCol.label}</b> — driven by the agents, not moved by hand.{' '}
              {!item.activeAgent && (
                <button
                  className="btn sm"
                  style={{ marginTop: 8 }}
                  disabled={busy}
                  onClick={pullBackToReady}
                >
                  ↩ Pull back to Ready
                </button>
              )}
            </div>
          ) : (
            <select value={columnId} onChange={(e) => setColumnId(e.target.value)}>
              {BOARD_COLUMNS.filter((c) => !c.locked).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="field grow">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as BacklogItemType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="row between">
        <button className="btn danger sm" disabled={busy} onClick={del}>
          Delete
        </button>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn sm" href={item.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <button className="btn primary" disabled={busy || !title.trim()} onClick={save}>
            {busy ? 'saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------
// Card (sortable) + Column (droppable)
// --------------------------------------------------------------------------

function CardInner({
  item,
  dragging,
}: {
  item: BacklogItem;
  dragging?: boolean;
}) {
  const sub = subTagForState(item.state);
  return (
    <div className={`kcard ${dragging ? 'dragging' : ''} ${item.activeAgent ? 'active' : ''}`}>
      <span className="num">#{item.number}</span>
      <div className="ktitle">{item.title}</div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className={`subtag ${item.type === 'bug' ? 'bug' : ''}`}>{item.type}</span>
        {item.activeAgent ? (
          <span className="subtag working" title={`${item.activeAgent.role} working`}>
            <span className="pulse" /> {item.activeAgent.agentName}
          </span>
        ) : (
          sub && <span className={`subtag ${sub.variant}`}>{sub.label}</span>
        )}
      </div>
    </div>
  );
}

function SortableCard({
  item,
  locked,
  onOpen,
}: {
  item: BacklogItem;
  locked: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(item.number),
    disabled: locked,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} onClick={onOpen} {...attributes} {...listeners}>
      <CardInner item={item} />
    </div>
  );
}

function Column({
  column,
  numbers,
  byNumber,
  onOpen,
}: {
  column: BoardColumn;
  numbers: number[];
  byNumber: ByNumber;
  onOpen: (item: BacklogItem) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: column.locked });
  return (
    <div className={`kcol ${isOver && !column.locked ? 'over' : ''} ${column.locked ? 'locked' : ''}`}>
      <h4>
        <span>
          {column.label} · {numbers.length}
        </span>
        {column.locked && (
          <span className="kcol-tag" title="Agents pick up Ready items and drive this stage">
            agents only
          </span>
        )}
      </h4>
      <SortableContext items={numbers.map(String)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="kcol-body">
          {numbers.map((n) => (
            <SortableCard
              key={n}
              item={byNumber[n]}
              locked={!!column.locked}
              onOpen={() => onOpen(byNumber[n])}
            />
          ))}
          {numbers.length === 0 && !column.locked && <div className="kcol-drop">drop here</div>}
          {numbers.length === 0 && column.locked && (
            <div className="kcol-drop muted">waiting for Ready items…</div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// --------------------------------------------------------------------------
// Board
// --------------------------------------------------------------------------

export function ProjectBoard({ projectId }: { projectId: string }) {
  const [columns, setColumns] = useState<Columns>({});
  const [byNumber, setByNumber] = useState<ByNumber>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BacklogItem>();
  const [activeId, setActiveId] = useState<number | null>(null);
  const startColRef = useRef<string | undefined>(undefined);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const load = () => {
    setErr(undefined);
    return api
      .backlog(projectId)
      .then((r) => {
        const built = buildColumns(r.items);
        setColumns(built.columns);
        setByNumber(built.byNumber);
      })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Live board: when an agent picks up / finishes a run, the item moves and the
  // "working" badge appears/clears. Don't reload mid-drag (would disrupt it).
  const draggingRef = useRef(false);
  useEffect(() => {
    return connectWs(
      (e) => {
        if ((e.type === 'run.updated' || e.type === 'backlog.updated') && !draggingRef.current) {
          void load();
        }
      },
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const containerOf = (id: string): string | undefined => {
    if (columns[id]) return id; // column id
    const num = Number(id);
    return Object.keys(columns).find((c) => columns[c].includes(num));
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = Number(e.active.id);
    draggingRef.current = true;
    setActiveId(id);
    startColRef.current = containerOf(String(id));
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeId2 = String(active.id);
    const overId = String(over.id);
    const activeCol = containerOf(activeId2);
    const overCol = columns[overId] ? overId : containerOf(overId);
    if (!activeCol || !overCol || activeCol === overCol) return;
    if (isLockedColumn(overCol)) return; // can't drop into an agent-controlled column

    setColumns((prev) => {
      const num = Number(activeId2);
      const overItems = prev[overCol];
      const newIndex = columns[overId]
        ? overItems.length
        : Math.max(0, overItems.indexOf(Number(overId)));
      return {
        ...prev,
        [activeCol]: prev[activeCol].filter((n) => n !== num),
        [overCol]: [...overItems.slice(0, newIndex), num, ...overItems.slice(newIndex)],
      };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const num = Number(active.id);
    draggingRef.current = false;
    setActiveId(null);
    if (!over) return;
    const overId = String(over.id);
    const finalCol = columns[overId] ? overId : containerOf(overId);
    if (!finalCol || isLockedColumn(finalCol)) {
      void load(); // resync — the optimistic onDragOver move (if any) is reverted
      return;
    }

    setColumns((prev) => {
      const arr = prev[finalCol];
      const oldIndex = arr.indexOf(num);
      const newIndex = columns[overId]
        ? arr.length - 1
        : arr.indexOf(Number(overId));
      const reordered =
        oldIndex >= 0 && newIndex >= 0 ? arrayMove(arr, oldIndex, newIndex) : arr;
      const next = { ...prev, [finalCol]: reordered };
      void persist(num, finalCol, next);
      return next;
    });
  };

  const persist = async (num: number, finalCol: string, snapshot: Columns) => {
    const startCol = startColRef.current;
    const changedColumn = startCol && startCol !== finalCol;
    try {
      if (changedColumn) {
        const col = BOARD_COLUMNS.find((c) => c.id === finalCol)!;
        const { item } = await api.updateIssue(projectId, num, { state: col.dropState });
        setByNumber((prev) => ({ ...prev, [num]: item }));
      }
      await api.setOrder(projectId, snapshot[finalCol]);
      if (changedColumn) await api.setOrder(projectId, snapshot[startCol]);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      void load(); // resync on failure
    }
  };

  if (loading) return <div className="spinner">loading backlog…</div>;

  const activeItem = activeId != null ? byNumber[activeId] : undefined;

  return (
    <>
      <div className="row" style={{ marginBottom: 12, justifyContent: 'flex-end' }}>
        <button className="btn sm primary" onClick={() => setCreating(true)}>
          + New work item
        </button>
      </div>
      {err && <div className="banner err">{err}</div>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="kanban">
          {BOARD_COLUMNS.map((col) => (
            <Column
              key={col.id}
              column={col}
              numbers={columns[col.id] ?? []}
              byNumber={byNumber}
              onOpen={setEditing}
            />
          ))}
        </div>
        <DragOverlay>{activeItem ? <CardInner item={activeItem} dragging /> : null}</DragOverlay>
      </DndContext>

      {creating && (
        <NewItemModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            // GitHub's issue list lags ~1s behind create, so a refetch here can
            // miss the new item. Insert the returned item directly instead; the
            // next ws event / drag reconciles ordering.
            const colId = columnForState(item.state).id;
            setByNumber((prev) => ({ ...prev, [item.number]: item }));
            setColumns((prev) =>
              prev[colId]?.includes(item.number)
                ? prev
                : { ...prev, [colId]: [item.number, ...(prev[colId] ?? [])] },
            );
          }}
        />
      )}
      {editing && (
        <EditItemModal
          projectId={projectId}
          item={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
          onDeleted={(number) => {
            setEditing(undefined);
            // Remove immediately; the closed issue drops out of the next fetch too.
            setColumns((prev) => {
              const next: Columns = {};
              for (const k of Object.keys(prev)) next[k] = prev[k].filter((n) => n !== number);
              return next;
            });
            setByNumber((prev) => {
              const next = { ...prev };
              delete next[number];
              return next;
            });
          }}
        />
      )}
    </>
  );
}
