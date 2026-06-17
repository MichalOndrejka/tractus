import {
  AGENT_PROVIDERS_INFO,
  providerInfo,
  type AgentProvider,
  type Skill,
} from '@tractus/shared';

export interface AgentDraft {
  name: string;
  provider: AgentProvider;
  model: string;
  dailyBudgetUsd: number;
  instructions: string;
  skills: Skill[];
}

const BUDGET_MAX = 50;

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export function AgentForm({
  value,
  onChange,
}: {
  value: AgentDraft;
  onChange: (v: AgentDraft) => void;
}) {
  const set = (patch: Partial<AgentDraft>) => onChange({ ...value, ...patch });

  const currentProvider = providerInfo(value.provider);
  const changeProvider = (id: AgentProvider) => {
    const info = providerInfo(id);
    // Keep the model if it's valid for the new provider, else pick its first.
    const model = info.models.some((m) => m.id === value.model)
      ? value.model
      : info.models[0]?.id ?? '';
    set({ provider: id, model });
  };

  const updateSkill = (id: string, patch: Partial<Skill>) =>
    set({ skills: value.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const addSkill = () =>
    set({ skills: [...value.skills, { id: newId(), name: '', content: '' }] });
  const removeSkill = (id: string) => set({ skills: value.skills.filter((s) => s.id !== id) });

  return (
    <div>
      <div className="field">
        <label>Agent name</label>
        <input value={value.name} onChange={(e) => set({ name: e.target.value })} />
      </div>

      <div className="field">
        <label>Provider</label>
        <select
          value={value.provider}
          onChange={(e) => changeProvider(e.target.value as AgentProvider)}
        >
          {AGENT_PROVIDERS_INFO.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.name}
              {p.available ? '' : ' — coming soon'}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Model</label>
        <select value={value.model} onChange={(e) => set({ model: e.target.value })}>
          {currentProvider.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>
          Daily budget — <span style={{ color: 'var(--signal)' }}>${value.dailyBudgetUsd.toFixed(2)}/day</span>
        </label>
        <input
          className="slider"
          type="range"
          min={0}
          max={BUDGET_MAX}
          step={0.5}
          value={value.dailyBudgetUsd}
          onChange={(e) => set({ dailyBudgetUsd: Number(e.target.value) })}
        />
        <div className="row between muted small">
          <span>$0</span>
          <span>${BUDGET_MAX}</span>
        </div>
      </div>

      <div className="field">
        <label>Agent file (system prompt)</label>
        <textarea
          rows={6}
          value={value.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          style={{ fontSize: 12, lineHeight: 1.5 }}
        />
      </div>

      <div className="field">
        <div className="row between" style={{ marginBottom: 8 }}>
          <label style={{ margin: 0 }}>Skills</label>
          <button type="button" className="btn sm" onClick={addSkill}>
            + Add skill
          </button>
        </div>
        {value.skills.length === 0 && (
          <div className="muted small" style={{ marginBottom: 8 }}>
            No skills yet.
          </div>
        )}
        {value.skills.map((s) => (
          <div className="card" key={s.id} style={{ marginBottom: 8 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <input
                placeholder="skill name"
                value={s.name}
                onChange={(e) => updateSkill(s.id, { name: e.target.value })}
                style={{ flex: 1, marginRight: 8 }}
              />
              <button type="button" className="btn sm danger" onClick={() => removeSkill(s.id)}>
                remove
              </button>
            </div>
            <textarea
              rows={3}
              placeholder="what this skill does / how to use it…"
              value={s.content}
              onChange={(e) => updateSkill(s.id, { content: e.target.value })}
              style={{ fontSize: 12 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
