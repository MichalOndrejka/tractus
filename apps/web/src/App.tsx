import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home.js';
import { Projects } from './pages/Projects.js';
import { ProjectDetail } from './pages/ProjectDetail.js';
import { AgentDetail } from './pages/AgentDetail.js';
import { Providers } from './pages/Providers.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/projects" element={<Projects />} />
      <Route path="/projects/:id" element={<ProjectDetail />} />
      <Route path="/projects/:id/agents/:agentId" element={<AgentDetail />} />
      <Route path="/providers" element={<Providers />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
