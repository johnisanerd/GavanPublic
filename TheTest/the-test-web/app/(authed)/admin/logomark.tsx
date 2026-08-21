// Official Palisade logo mark — five palisade "pickets" of varied height.
// Paths are the canonical brand asset, inlined so it stays a single themeable
// color and renders crisp at any size:
//   Brand/Logos/Logo Mark/RGB/palisades-research_logo-mark_inverse_rgb.svg
// Native art is 194.7 × 148.6 (wider than tall); we size by width and keep that
// aspect so the pickets aren't squished.
export function Logomark({
  size = 22,
  color = "var(--primary)",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={(size * 148.6) / 194.7}
      viewBox="0 0 194.7 148.6"
      fill={color}
      aria-hidden="true"
      role="presentation"
      style={{ display: "block", flex: "none" }}
    >
      <path d="M72.2,40.2l-13.8-23.1c-.7-1.1-2.3-1.1-3,0l-13.8,23.1c-.7,1.2-1.1,2.5-1.1,3.9v86.2c0,1.1.7,2.1,1.8,2.4l14.6,4.3,13.2,3.8c1.6.5,3.2-.7,3.2-2.4V44.1c0-1.4-.4-2.7-1.1-3.9h0Z" />
      <path d="M31.7,61.6l-13.8-23.1c-.7-1.1-2.3-1.1-3,0L1.1,61.5c-.7,1.2-1.1,2.5-1.1,3.9v52.8c0,1.1.7,2.1,1.8,2.4l14.6,4.3,13.2,3.8c1.6.5,3.2-.7,3.2-2.4v-60.9c0-1.4-.4-2.7-1.1-3.9h0Z" />
      <path d="M122.5,40.2l13.8-23.1c.7-1.1,2.3-1.1,3,0l13.8,23.1c.7,1.2,1.1,2.5,1.1,3.9v86.2c0,1.1-.7,2.1-1.8,2.4l-14.6,4.3-13.2,3.8c-1.6.5-3.2-.7-3.2-2.4V44.1c0-1.4.4-2.7,1.1-3.9h0Z" />
      <path d="M163,61.6l13.8-23.1c.7-1.1,2.3-1.1,3,0l13.8,23.1c.7,1.2,1.1,2.5,1.1,3.9v52.8c0,1.1-.7,2.1-1.8,2.4l-14.6,4.3-13.2,3.8c-1.6.5-3.2-.7-3.2-2.4v-60.9c0-1.4.4-2.7,1.1-3.9h0Z" />
      <path d="M112.7,23.9L98.9.8c-.7-1.1-2.3-1.1-3,0l-13.8,23.1c-.7,1.2-1.1,2.5-1.1,3.9v114.3c0,1.1.7,2.1,1.8,2.4l13.1,3.9c.9.3,2,.3,2.9,0l13.1-3.9c1.1-.3,1.8-1.3,1.8-2.4V27.8c0-1.4-.4-2.7-1.1-3.9h0Z" />
    </svg>
  );
}
