import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Project } from '@tractus/shared';
import { Screen } from '../components/Screen.js';
import { ProjectBoard } from '../components/ProjectBoard.js';
import { ProjectAgents } from '../components/ProjectAgents.js';
import { api } from '../api.js';

type Tab = 'board' | 'agents';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'board';
  const [project, setProject] = useState<Project>();

  useEffect(() => {
    if (id) api.project(id).then((r) => setProject(r.project)).catch(() => undefined);
  }, [id]);

  if (!id) return null;

  return (
    <Screen
      title={project?.name ?? 'Project'}
      accent={project ? `· ${project.repo}` : undefined}
      back
      fill
    >
      <div className="proj-layout">
        <nav className="subnav">
          <button
            className={tab === 'board' ? 'active' : ''}
            onClick={() => setParams({ tab: 'board' })}
          >
            <span className="glyph">▤</span> <span>Board</span>
          </button>
          <button
            className={tab === 'agents' ? 'active' : ''}
            onClick={() => setParams({ tab: 'agents' })}
          >
            <span className="glyph">⌬</span> <span>Agents</span>
          </button>
        </nav>
        <div className="proj-content">
          {tab === 'board' ? <ProjectBoard projectId={id} /> : <ProjectAgents projectId={id} />}
        </div>
      </div>
    </Screen>
  );
}
