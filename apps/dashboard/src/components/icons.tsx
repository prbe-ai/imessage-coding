/* Neutral product mark — a simple phone glyph with no brand identity.
 * `currentColor` lets the mark invert against light or dark surfaces. */

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="2" width="14" height="20" rx="3" />
      <path d="M12 18h.01" />
    </svg>
  );
}

/* Mark-only brand lockup (no wordmark). Keeps the onboarding/sign-in layout
 * hooks (`.onb-brand` / `.onb-mark`) while shipping no product name. */
export function Brand({ className }: { className?: string }) {
  return (
    <div className={`onb-brand${className ? ` ${className}` : ""}`}>
      <div className="onb-mark">
        <BrandMark />
      </div>
    </div>
  );
}
