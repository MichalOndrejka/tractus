import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  defaultWorkflowGraph,
  emptyWorkflowGraph,
  type AgentRole,
  type DeployedAgent,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '@tractus/shared';
import { api } from '../api.js';

// --------------------------------------------------------------------------
// n8n-style pipeline editor: draggable agent nodes wired together by edges.
// Lives behind the board's "In Progress" column. Authors + persists the graph
// (per project); the runtime still uses the built-in pipeline for now.
// --------------------------------------------------------------------------

const NODE_W = 196;
const NODE_H = 70;
const PORT_HIT = 30; // px radius to snap a dropped connection onto an input port

const ROLE_GLYPH: Record<AgentRole, string> = {
  architect: '◈',
  developer: '⌁',
  tester: '✓',
  reviewer: '◎',
};

interface Point {
  x: number;
  y: number;
}

/** A palette entry's payload — what an agent node is created from on drop. */
interface AgentNodeDescriptor {
  role: AgentRole;
  label: string;
  source: { type: 'agent'; id: string };
}

/** Geometry of a node's two ports in canvas space. */
function ports(n: WorkflowNode): { in: Point; out: Point } {
  return {
    in: { x: n.x, y: n.y + NODE_H / 2 },
    out: { x: n.x + NODE_W, y: n.y + NODE_H / 2 },
  };
}

/** A left→right cubic bezier between two points (n8n-style sweeping wire). */
function wirePath(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

type Interaction =
  | { kind: 'drag'; nodeId: string; dx: number; dy: number }
  | { kind: 'connect'; fromId: string }
  | { kind: 'pan'; startX: number; startY: number; scrollLeft: number; scrollTop: number }
  | null;

export function WorkflowCanvas({ projectId }: { projectId: string }) {
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [agents, setAgents] = useState<DeployedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [connectPt, setConnectPt] = useState<Point>();
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction>(null);
  const dragItem = useRef<AgentNodeDescriptor | null>(null);
  // Keep the latest zoom available to the native (non-passive) wheel listener.
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // Scroll position to apply on the next paint so a zoom keeps a chosen point fixed.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.workflow(projectId).catch(() => ({ workflow: defaultWorkflowGraph() })),
      api.agents(projectId).catch(() => ({ agents: [] as DeployedAgent[] })),
    ])
      .then(([w, a]) => {
        if (!alive) return;
        setGraph(w.workflow);
        setAgents(a.agents);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId]);

  const byId = useMemo(() => {
    const m = new Map<string, WorkflowNode>();
    graph.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph.nodes]);

  // Canvas content extent — grow to fit the furthest node so wires never clip.
  const extent = useMemo(() => {
    let w = 1200;
    let h = 680;
    for (const n of graph.nodes) {
      w = Math.max(w, n.x + NODE_W + 240);
      h = Math.max(h, n.y + NODE_H + 200);
    }
    return { w, h };
  }, [graph.nodes]);

  // --- coordinate helpers ---------------------------------------------------

  // Screen point -> unscaled node space (divide out the current zoom).
  const toCanvas = (e: { clientX: number; clientY: number }): Point => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    const z = zoomRef.current;
    return { x: (e.clientX - r.left + el.scrollLeft) / z, y: (e.clientY - r.top + el.scrollTop) / z };
  };

  // --- zoom (no clamp — unlimited in/out) -----------------------------------

  /** Rescale around a viewport point (cx,cy relative to the canvas), keeping it fixed. */
  const zoomAround = (next: number, cx: number, cy: number) => {
    const el = canvasRef.current;
    if (!el || !Number.isFinite(next) || next <= 0) {
      setZoom((z) => (Number.isFinite(next) && next > 0 ? next : z));
      return;
    }
    const z = zoomRef.current;
    const px = (cx + el.scrollLeft) / z;
    const py = (cy + el.scrollTop) / z;
    pendingScroll.current = { left: px * next - cx, top: py * next - cy };
    setZoom(next);
  };

  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    zoomAround(zoomRef.current * factor, cx, cy);
  };

  const resetZoom = () => {
    pendingScroll.current = { left: 0, top: 0 };
    setZoom(1);
  };

  // Apply the queued scroll right after the zoomed surface has laid out.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  }, [zoom]);

  // Ctrl/⌘ + wheel zooms toward the cursor. Attached natively (non-passive) so
  // preventDefault works — React's onWheel is passive and can't block the page.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll/pan stays default
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAround(zoomRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // --- mutations ------------------------------------------------------------

  const mutate = (fn: (g: WorkflowGraph) => WorkflowGraph) => {
    setGraph(fn);
    setDirty(true);
  };

  const moveNode = (id: string, x: number, y: number) =>
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, x: Math.max(0, x), y: Math.max(0, y) } : n)),
    }));

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const target = byId.get(to);
    if (!target || target.kind === 'source') return; // source has no input
    mutate((g) => {
      if (g.edges.some((e) => e.from === from && e.to === to)) return g;
      const edge: WorkflowEdge = { id: `e-${crypto.randomUUID()}`, from, to };
      return { ...g, edges: [...g.edges, edge] };
    });
  };

  const removeEdge = (id: string) => {
    setSelectedEdge(undefined);
    mutate((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }));
  };

  const removeNode = (id: string) =>
    mutate((g) => ({
      nodes: g.nodes.filter((n) => n.id !== id),
      edges: g.edges.filter((e) => e.from !== id && e.to !== id),
    }));

  const addAgentNodeAt = (input: AgentNodeDescriptor, x: number, y: number) => {
    const node: WorkflowNode = {
      id: `n-${crypto.randomUUID()}`,
      kind: 'agent',
      label: input.label,
      role: input.role,
      source: input.source,
      x: Math.max(0, x),
      y: Math.max(0, y),
    };
    mutate((g) => ({ ...g, nodes: [...g.nodes, node] }));
  };

  // Native drag-and-drop: a palette item is dragged onto the canvas and dropped
  // where the cursor releases (node centered on the drop point).
  const onCanvasDragOver = (e: React.DragEvent) => {
    if (!dragItem.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onCanvasDrop = (e: React.DragEvent) => {
    const item = dragItem.current;
    dragItem.current = null;
    if (!item) return;
    e.preventDefault();
    const p = toCanvas(e);
    addAgentNodeAt(item, p.x - NODE_W / 2, p.y - NODE_H / 2);
  };

  // --- pointer interactions (drag nodes, draw wires) ------------------------

  const startDrag = (e: React.PointerEvent, n: WorkflowNode) => {
    e.stopPropagation();
    setSelectedEdge(undefined);
    const p = toCanvas(e);
    interaction.current = { kind: 'drag', nodeId: n.id, dx: p.x - n.x, dy: p.y - n.y };
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const startConnect = (e: React.PointerEvent, n: WorkflowNode) => {
    e.stopPropagation();
    const p = toCanvas(e);
    interaction.current = { kind: 'connect', fromId: n.id };
    setConnectPt(p);
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  // Map-style pan: press empty canvas and drag to scroll the whole view. Reaches
  // here only for empty space — nodes/ports/edges stopPropagation their own press.
  const startPan = (e: React.PointerEvent) => {
    setSelectedEdge(undefined);
    const el = canvasRef.current;
    if (!el) return;
    interaction.current = {
      kind: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setPanning(true);
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const it = interaction.current;
    if (!it) return;
    if (it.kind === 'pan') {
      const el = canvasRef.current!;
      el.scrollLeft = it.scrollLeft - (e.clientX - it.startX);
      el.scrollTop = it.scrollTop - (e.clientY - it.startY);
      return;
    }
    const p = toCanvas(e);
    if (it.kind === 'drag') moveNode(it.nodeId, p.x - it.dx, p.y - it.dy);
    else setConnectPt(p);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const it = interaction.current;
    interaction.current = null;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    if (!it) return;
    if (it.kind === 'pan') {
      setPanning(false);
      return;
    }
    if (it.kind === 'drag') {
      setDirty(true);
    } else {
      // snap onto the nearest input port within range
      const p = toCanvas(e);
      let best: { id: string; d: number } | undefined;
      for (const n of graph.nodes) {
        if (n.id === it.fromId || n.kind === 'source') continue;
        const ip = ports(n).in;
        const d = Math.hypot(ip.x - p.x, ip.y - p.y);
        if (d <= PORT_HIT && (!best || d < best.d)) best = { id: n.id, d };
      }
      if (best) addEdge(it.fromId, best.id);
    }
    setConnectPt(undefined);
  };

  // --- save -----------------------------------------------------------------

  const save = async () => {
    setSaving(true);
    setErr(undefined);
    try {
      const { workflow } = await api.saveWorkflow(projectId, {
        nodes: graph.nodes,
        edges: graph.edges,
      });
      setGraph(workflow);
      setDirty(false);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const resetDefault = () => {
    if (!window.confirm('Reset to just Ready / Done? All agents and wiring will be cleared.')) return;
    setGraph(emptyWorkflowGraph());
    setDirty(true);
    setSelectedEdge(undefined);
  };

  // Palette entries are the agents deployed in THIS project. Each carries the
  // descriptor used to build a node when it's dragged onto the canvas.
  const paletteItems = useMemo(
    () =>
      agents.map((a) => ({
        key: a.id,
        node: { role: a.role, label: a.name, source: { type: 'agent' as const, id: a.id } },
      })),
    [agents],
  );

  if (loading) return <div className="spinner">loading pipeline…</div>;

  return (
    <div className="wf">
      <div className="wf-toolbar">
        <div className="row" style={{ gap: 10 }}>
          <span className="muted small">
            {graph.nodes.length} nodes · {graph.edges.length} wires
          </span>
          {dirty ? (
            <span className="subtag prio">unsaved</span>
          ) : (
            <span className="subtag state">saved</span>
          )}
        </div>
        {err && <span className="small" style={{ color: 'var(--danger)' }}>{err}</span>}
        <div className="row" style={{ gap: 8 }}>
          <div className="wf-zoomctl" title="Ctrl / ⌘ + scroll to zoom">
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
            <button className="wf-zoom-val" onClick={resetZoom} title="Reset to 100%">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
          </div>
          <button className="btn sm" onClick={resetDefault} disabled={saving}>
            ↺ Reset
          </button>
          <button className="btn sm primary" onClick={save} disabled={saving || !dirty}>
            {saving ? 'saving…' : 'Save pipeline'}
          </button>
        </div>
      </div>

      <div className="wf-body">
        <aside className="wf-palette">
          <div className="wf-palette-h">My agents</div>
          <div className="muted small" style={{ padding: '0 2px 10px', lineHeight: 1.5 }}>
            Drag an agent onto the canvas, then wire the output port (right) into the
            next agent's input (left).
          </div>
          {paletteItems.length === 0 && (
            <div className="muted small" style={{ lineHeight: 1.6 }}>
              No agents deployed yet. Add agents in the Agents tab, then drag them here.
            </div>
          )}
          {paletteItems.map((p) => (
            <div
              key={p.key}
              className={`wf-pal-item role-${p.node.role}`}
              draggable
              onDragStart={(e) => {
                dragItem.current = p.node;
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', p.node.label);
              }}
              onDragEnd={() => {
                dragItem.current = null;
              }}
            >
              <span className="wf-pal-glyph">{ROLE_GLYPH[p.node.role]}</span>
              <span className="wf-pal-text">
                <span className="wf-pal-name">{p.node.label}</span>
                <span className="wf-pal-sub">{p.node.role}</span>
              </span>
              <span className="wf-pal-grip">⠿</span>
            </div>
          ))}
        </aside>

        <div
          ref={canvasRef}
          className={`wf-canvas ${panning ? 'panning' : ''}`}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerDown={startPan}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
        >
          <div className="wf-surface" style={{ width: extent.w * zoom, height: extent.h * zoom }}>
            <div
              className="wf-zoom"
              style={{ width: extent.w, height: extent.h, transform: `scale(${zoom})` }}
            >
            <svg className="wf-edges" width={extent.w} height={extent.h}>
              <defs>
                <marker
                  id="wf-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--signal)" />
                </marker>
              </defs>
              {graph.edges.map((e) => {
                const from = byId.get(e.from);
                const to = byId.get(e.to);
                if (!from || !to) return null;
                const a = ports(from).out;
                const b = ports(to).in;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const active = selectedEdge === e.id;
                return (
                  <g key={e.id} className={`wf-edge ${active ? 'sel' : ''}`}>
                    <path className="wf-wire" d={wirePath(a, b)} markerEnd="url(#wf-arrow)" />
                    <path
                      className="wf-wire-hit"
                      d={wirePath(a, b)}
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        setSelectedEdge(e.id);
                      }}
                    />
                    {active && (
                      <g
                        className="wf-wire-del"
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          removeEdge(e.id);
                        }}
                      >
                        <circle cx={mid.x} cy={mid.y} r={10} />
                        <text x={mid.x} y={mid.y + 4} textAnchor="middle">
                          ×
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
              {/* live wire being drawn */}
              {interaction.current?.kind === 'connect' &&
                connectPt &&
                byId.get(interaction.current.fromId) && (
                  <path
                    className="wf-wire drawing"
                    d={wirePath(ports(byId.get(interaction.current.fromId)!).out, connectPt)}
                  />
                )}
            </svg>

            {graph.nodes.map((n) => {
              const cls =
                n.kind === 'source' ? 'source' : n.kind === 'sink' ? 'sink' : `agent role-${n.role}`;
              const glyph =
                n.kind === 'source' ? '▶' : n.kind === 'sink' ? '◼' : ROLE_GLYPH[n.role!];
              const sub = n.kind === 'source' ? 'start' : n.kind === 'sink' ? 'end' : n.role;
              return (
                <div
                  key={n.id}
                  className={`wf-node ${cls}`}
                  style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                  onPointerDown={(e) => startDrag(e, n)}
                >
                  {/* Ready Tasks has no input; Done Tasks has no output. */}
                  {n.kind !== 'source' && <span className="wf-port in" title="input" />}
                  {n.kind !== 'sink' && (
                    <span
                      className="wf-port out"
                      title="drag to connect"
                      onPointerDown={(e) => startConnect(e, n)}
                    />
                  )}
                  <span className="wf-node-glyph">{glyph}</span>
                  <span className="wf-node-text">
                    <span className="wf-node-name">{n.label}</span>
                    <span className="wf-node-sub">{sub}</span>
                  </span>
                  {n.kind === 'agent' && (
                    <button
                      className="wf-node-del"
                      title="remove node"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        removeNode(n.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
