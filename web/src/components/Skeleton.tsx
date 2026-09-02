export function Skeleton() {
  return (
    <div className="screen" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading your coffee</span>
      <div className="skeleton skeleton--name" />
      <div className="skeleton skeleton--hero" />
      <div className="skeleton skeleton--card" />
      <div className="skeleton skeleton--card" />
    </div>
  )
}
