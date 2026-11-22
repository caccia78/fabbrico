import { useStore } from '../model/store';
import { THICKNESS_BANDS } from './thicknessScale';

/** Colour key shown in the viewport while the Thickness view is on. */
export function ThicknessLegend() {
  const overlay = useStore((s) => s.overlay);
  const nozzle = useStore((s) => s.settings.nozzle);
  if (overlay !== 'thickness') return null;
  return (
    <div className="legend">
      <b>Wall thickness</b>
      {THICKNESS_BANDS.map((b) => (
        <span key={b.color}>
          <i style={{ background: b.color }} />
          {b.label(nozzle)}
        </span>
      ))}
    </div>
  );
}
