// Tailwind CSS v4 runs through its PostCSS plugin (Next 16 / Turbopack compatible).
// Tailwind is scoped to the admin surface only — see app/(authed)/admin/admin.css.
// The public pages render from app/globals.css (raw inline styles + ps-* classes)
// and must NOT receive Tailwind's Preflight base reset.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
