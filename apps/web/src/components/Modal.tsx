import type { ReactNode } from 'react';

export function Modal({
  title,
  onClose,
  children,
  size = 'default',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 'large' fills almost the whole screen — for content-heavy desktop dialogs. */
  size?: 'default' | 'large';
}) {
  return (
    <div className="scrim" onClick={onClose}>
      <div
        className={`modal ${size === 'large' ? 'large' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
