// Single source of truth for the admin auth bypass used during local design work.
//
// It is active ONLY when BOTH hold:
//   1. the build is NOT production (NODE_ENV !== "production"), and
//   2. NEXT_PUBLIC_ADMIN_DEV_NO_AUTH === "1" (set only in gitignored .env.local).
//
// The NODE_ENV guard means the bypass can never disable Clerk in a real deploy,
// even if the flag were ever mistakenly added to a Vercel/preview environment —
// production builds always have NODE_ENV="production". Belt and suspenders for an
// admin panel that holds real participant data.
export const DEV_NO_AUTH =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_ADMIN_DEV_NO_AUTH === "1";
