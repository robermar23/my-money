// Schema barrel: re-exports every table + relations file so the Drizzle client
// can pick them up in one import and so drizzle-kit can discover them.
//
// Each domain concept gets its own file (per CLAUDE.md §Database & Drizzle Specifics).
// Phase 0 starts with only `users` — Phase 1 adds accounts, holdings, etc.

export * from "./users.ts";
