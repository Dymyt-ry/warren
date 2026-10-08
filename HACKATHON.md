# Hackathon — Warren session routing

Start: 2026-10-08   End: ~2 hours later   Deliverables: live demo ☑ deck ☑ video ☐
Profile: 2h   Team: solo   Confirmed by user: ☑
Roles: @tim → builder/demo owner
Judging focus: existing Warren product story plus a reliable live multi-session agent demo.

- [x] 0. Kickoff — 2h solo profile, live demo priority                         @tim
- [x] 1. Idea check — agents need short routed messages, not shared transcripts @tim
- [x] 2. Market check — existing `MARKET.md`; verdict pivot/go implemented      @tim
- [x] 3. MVP scope — named sessions, leases, exact routing, visible identity     @tim
- [x] 4. Business model — existing `MARKET.md`                                  @tim
- [x] 5. Brand — existing `brand/BRAND.md` and `web/DESIGN.md`                   @tim
- [x] 6. UI direction — existing dashboard design system                         @tim
- [ ] 7. Build — named-session happy path works end to end                       @tim
- [ ] 8. Polish + feature freeze                                                  @tim
- [ ] 9. Repo README — session quickstart and proof                               @tim
- [ ] 10. Pitch story — session routing beat                                      @tim
- [ ] 11. Slides — existing deck updated only if time remains                     @tim
- [ ] 12. Demo video — optional; live demo is confirmed deliverable               @tim
- [ ] 13. Rehearsal — exact terminal/UI path                                      @tim

Skipped by user: none

## Critical flow

1. Start two terminals from one configured agent: `warren codex --name api` and `warren codex --name review`.
2. Each connection receives an opaque Warren session id and renews a lease.
3. Dashboard and agents see `@agent/api` and `@agent/review` with online state.
4. A message to `@agent/review` reaches only that session; replies show the source session name.
5. Closing a terminal expires its lease without deleting message history.

## Won't have in this build

- Cross-device synchronization of native Claude/Codex transcript ids.
- Automatic routing based on file ownership or branch names.
- A general agent inbox claim protocol; bare `@agent` keeps existing compatible delivery semantics.
