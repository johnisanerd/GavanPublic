import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

/**
 * Bottom-right fullscreen toggle. Barely visible by default — the
 * stage is supposed to read as a single uninterrupted projection
 * surface, not a UI. Hovering lifts the opacity enough to find it
 * without lighting up the room.
 */
export function FullscreenButton() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        /* user-agent declined — nothing to do */
      });
    } else {
      document.exitFullscreen().catch(() => {
        /* noop */
      });
    }
  };

  const Icon = isFullscreen ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isFullscreen ? 'exit fullscreen' : 'enter fullscreen'}
      className="pointer-events-auto fixed bottom-3 right-3 z-50 grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[var(--color-ink-1)] transition-opacity duration-200"
      style={{ opacity: 0.06 }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.06')}
      onFocus={(e) => (e.currentTarget.style.opacity = '0.7')}
      onBlur={(e) => (e.currentTarget.style.opacity = '0.06')}
    >
      <Icon size={14} strokeWidth={1.5} />
    </button>
  );
}
