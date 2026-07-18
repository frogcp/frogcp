/**
 * The frog logo mark: a hand-maintained inline SVG brand asset, not a generic
 * icon. Every other icon in this app comes from `lucide-react`.
 */
export function FrogMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      <rect x="6" y="6" width="108" height="108" rx="30" style={{ fill: "var(--primary)" }} />
      <circle cx="44" cy="50" r="20" fill="#fff" />
      <circle cx="76" cy="50" r="20" fill="#fff" />
      <circle cx="48" cy="54" r="8" style={{ fill: "var(--logo-pupil)" }} />
      <circle cx="72" cy="54" r="8" style={{ fill: "var(--logo-pupil)" }} />
    </svg>
  );
}
