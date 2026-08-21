import { useId, useMemo } from 'react';

/**
 * Aspect-ratio slider on a log2 scale so 1:1 sits at the visual center
 * and portrait/landscape are symmetric. Magnetic detents pull the
 * thumb to common ratios — drag through them feels like clicking
 * past stops, but you can fine-tune off-snap if you want.
 *
 * Stored as a [w, h] tuple to keep VignetteOverlay's math untouched;
 * we always write [ratio, 1] since the overlay normalizes by max.
 */
const SNAPS: Array<{ ratio: number; label: string }> = [
  { ratio: 2 / 5,   label: '2:5'   },
  { ratio: 9 / 21,  label: '9:21'  },
  { ratio: 1 / 2,   label: '1:2'   },
  { ratio: 9 / 16,  label: '9:16'  },
  { ratio: 3 / 4,   label: '3:4'   },
  { ratio: 4 / 5,   label: '4:5'   },
  { ratio: 1,       label: '1:1'   },
  { ratio: 5 / 4,   label: '5:4'   },
  { ratio: 4 / 3,   label: '4:3'   },
  { ratio: 16 / 9,  label: '16:9'  },
  { ratio: 21 / 9,  label: '21:9'  },
];

const LOG_MIN = Math.log2(2 / 5) - 0.1;           // a hair beyond 2:5
const LOG_MAX = Math.log2(21 / 9) + 0.1;          // a hair beyond 21:9
const SNAP_RADIUS_LOG = 0.045;                    // ≈3% ratio either side
const STEP_LOG = 0.005;

interface AspectSliderProps {
  aspect: [number, number];
  onChange: (next: [number, number]) => void;
}

export function AspectSlider({ aspect, onChange }: AspectSliderProps) {
  const id = useId();
  const ratio = aspect[0] / aspect[1];
  const logRatio = Math.log2(ratio);

  // What label to show — snap label when within snap radius, otherwise
  // the live ratio in n:m or decimal form.
  const display = useMemo(() => {
    for (const s of SNAPS) {
      if (Math.abs(Math.log2(s.ratio) - logRatio) < SNAP_RADIUS_LOG) return s.label;
    }
    return `${ratio.toFixed(2)}`;
  }, [logRatio, ratio]);

  const onSliderChange = (raw: number) => {
    let v = raw;
    // Magnetic snap — pull to the nearest snap inside the radius.
    let bestDelta = Infinity;
    let bestSnap = NaN;
    for (const s of SNAPS) {
      const sl = Math.log2(s.ratio);
      const d = Math.abs(sl - v);
      if (d < SNAP_RADIUS_LOG && d < bestDelta) {
        bestDelta = d;
        bestSnap = sl;
      }
    }
    if (!Number.isNaN(bestSnap)) v = bestSnap;
    const r = Math.pow(2, v);
    onChange([r, 1]);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">
          aspect
        </label>
        <span className="font-mono text-[10px] text-[var(--color-ink-3)]">{display}</span>
      </div>
      <div className="relative">
        <input
          id={id}
          type="range"
          min={LOG_MIN}
          max={LOG_MAX}
          step={STEP_LOG}
          value={logRatio}
          onChange={(e) => onSliderChange(Number(e.target.value))}
        />
        {/* Detent ticks — purely visual; pointer-events-none so they
            don't interfere with the slider itself. */}
        <div className="pointer-events-none absolute inset-x-0 -top-0.5 h-[8px]">
          {SNAPS.map((s) => {
            const t = (Math.log2(s.ratio) - LOG_MIN) / (LOG_MAX - LOG_MIN);
            return (
              <span
                key={s.label}
                className="absolute top-0 h-[6px] w-px bg-[var(--color-border-strong)]"
                style={{ left: `calc(${t * 100}% )` }}
                title={s.label}
              />
            );
          })}
        </div>
      </div>
      <div className="flex justify-between text-[9px] uppercase tracking-[0.16em] text-[var(--color-ink-5)]">
        <span>portrait</span>
        <span>1:1</span>
        <span>landscape</span>
      </div>
    </div>
  );
}
