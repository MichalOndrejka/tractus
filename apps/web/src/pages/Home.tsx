import { useNavigate } from 'react-router-dom';
import { Screen } from '../components/Screen.js';
import { api } from '../api.js';

interface Tile {
  id: string;
  glyph: string;
  name: string;
  to?: string;
  soon?: boolean;
}

export function Home() {
  const navigate = useNavigate();

  const tiles: Tile[] = [
    {
      id: 'projects',
      glyph: '▤',
      name: 'Projects',
      to: '/projects',
    },
    {
      id: 'providers',
      glyph: '◈',
      name: 'Providers',
      to: '/providers',
    },
    { id: 'automations', glyph: '⚡', name: 'Automations', soon: true },
    { id: 'insights', glyph: '◫', name: 'Insights', soon: true },
    { id: 'settings', glyph: '⚙', name: 'Settings', soon: true },
  ];

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      window.location.reload();
    }
  };

  return (
    <Screen
      title="TRACTUS"
      actions={
        <button className="btn sm" onClick={logout}>
          sign out
        </button>
      }
    >
      <div className="section-title">Workspace</div>
      <div className="tiles">
        {tiles.map((t) => (
          <div
            key={t.id}
            className={`tile ${t.soon ? 'disabled' : ''}`}
            onClick={() => t.to && navigate(t.to)}
            role={t.to ? 'button' : undefined}
          >
            <span className="glyph">{t.glyph}</span>
            <span className="name">{t.name}</span>
            <span className="status">{t.soon ? 'soon' : 'open'}</span>
          </div>
        ))}
      </div>
    </Screen>
  );
}
