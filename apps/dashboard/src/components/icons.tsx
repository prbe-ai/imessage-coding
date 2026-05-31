/* Probe brand mark + lockup. Same glyph as prbe-dashboard so the two
 * surfaces read as one product. `currentColor` lets the mark invert against
 * dark canvases. */

export function ProbeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" className={className}>
      <path d="M56.79,118l64,36-64,36v-72Z" fill="currentColor" opacity="0.18" />
      <path d="M77.21,94l78,48-78,48v-96Z" fill="currentColor" opacity="0.4" />
      <path d="M99.21,66l100,62-100,62v-124Z" fill="currentColor" />
    </svg>
  );
}

export function ProbeBrand({ className }: { className?: string }) {
  return (
    <div className={`onb-brand${className ? ` ${className}` : ""}`}>
      <div className="onb-mark">
        <ProbeMark />
      </div>
      <div className="onb-wm">Probe</div>
    </div>
  );
}
