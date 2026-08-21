"use client";

import * as React from "react";
import { Play, Square } from "lucide-react";

// Inline, compact audio control: a small bordered play button that, while
// playing, expands to a pause button + a counting-up timer (m:ss). Lazy-loads
// the audio on first play (so the generate-on-demand endpoint only fires when
// actually played), and stops propagation so it works inside clickable rows.
// Reusable wherever a voice answer appears (response rows, live feed, Questions).
export function MiniAudio({
  src,
  onEnded,
  active,
  className = "",
}: {
  src: string;
  onEnded?: () => void;
  // For autoplay chains: when this flips true the clip plays; false pauses it.
  active?: boolean;
  className?: string;
}) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const onEndedRef = React.useRef(onEnded);
  onEndedRef.current = onEnded;

  const ensure = React.useCallback(() => {
    if (!audioRef.current) {
      const a = new Audio(src);
      a.addEventListener("timeupdate", () => setElapsed(a.currentTime));
      a.addEventListener("play", () => setPlaying(true));
      a.addEventListener("pause", () => setPlaying(false));
      a.addEventListener("ended", () => {
        setPlaying(false);
        setElapsed(0);
        onEndedRef.current?.();
      });
      audioRef.current = a;
    }
    return audioRef.current;
  }, [src]);

  React.useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  // Driven externally (autoplay): play when active, pause when not.
  React.useEffect(() => {
    if (active === undefined) return;
    if (active) void ensure().play();
    else audioRef.current?.pause();
  }, [active, ensure]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const a = ensure();
    if (a.paused) void a.play();
    else {
      a.pause();
      a.currentTime = 0; // stop = back to start, not pause-in-place
    }
  }

  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? "Stop" : "Play"}
      className={`text-foreground border-foreground/20 hover:border-foreground/40 hover:bg-accent inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${className}`}
    >
      {playing ? (
        <Square className="size-3 fill-current text-destructive" /> /* stop = red glyph */
      ) : (
        <Play className="size-3 fill-current text-success" /> /* play = green glyph */
      )}
      {playing && (
        <span className="font-mono tabular-nums">
          {m}:{String(s).padStart(2, "0")}
        </span>
      )}
    </button>
  );
}
