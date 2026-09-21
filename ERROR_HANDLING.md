# Error Handling & User Feedback

## The discovery problem

When a cinema site or rating source changes, the app silently produces wrong or missing data. The user is the canary — they notice something is wrong and report it. **The quality of their feedback determines fix speed.**

```
Server changes → App produces wrong/missing data → User notices → Bug report → Fix
                                                        │
                                    Good feedback (specific error + diagnostic info) → fast fix
                                    Bad feedback (generic "it's broken") → slow fix
```

## Current error feedback — audit by failure mode

| Failure mode                   | What user sees                                                              | Actionable?                                             | Diagnostic info?                        | Gap                                   |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| **Cinema HTML redesigned**     | `CinemaStatusBanner`: "programmation indisponible (format du site modifié)" | ✅ Knows which cinema                                   | ❌ No details to copy                   | Need "report issue" button            |
| **Cinema server down**         | `CinemaStatusBanner`: "(erreur HTTP)" or "(délai dépassé)"                  | ✅ Knows which cinema                                   | ❌ No timestamp of last success         | Need "last OK" timestamp              |
| **Cloudflare added to cinema** | Same as server down (timeout or http-error)                                 | ⚠️ Misleading — user thinks server is down, not blocked | ❌ No distinction                       | Need "blocked by anti-bot" status     |
| **AlloCiné HTML changed**      | `StatusBadge`: red ⚠ + tooltip with raw error                               | ✅ Knows which source                                   | ⚠️ Tooltip not copyable                 | Need copyable error text              |
| **RT HTML changed**            | Same as AlloCiné                                                            | ✅                                                      | ⚠️                                      | Same                                  |
| **Wikidata SPARQL fails**      | ❌ **Silent failure** — no badges appear                                    | ❌ User doesn't know why                                | ❌ Nothing                              | Need "ID resolution failed" indicator |
| **IMDB dataset unavailable**   | IMDB badges show "absent"                                                   | ❌ Misleading — looks like film has no rating           | ❌ Nothing                              | Need "dataset stale" indicator        |
| **All rating sources blocked** | Retry button (⚡) appears in header                                         | ✅ Can retry                                            | ⚠️ Retry result not copyable            | Need "copy diagnostics" button        |
| **IPC handler crash**          | `ErrorBoundary`: "Une erreur est survenue"                                  | ✅ Error message shown                                  | ⚠️ Stack trace visible but not copyable | Need "copy error" button              |

## Error categories — what they mean + user guidance

| Category      | Technical cause                                                      | User-facing message                                                            | Suggested action                       |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `transient`   | Network timeout, 5xx, connection reset                               | "Le serveur ne répond pas. Réessayez plus tard."                               | Wait + retry                           |
| `http-error`  | 4xx (not 404), 5xx                                                   | "Le site est temporairement indisponible."                                     | Wait + retry                           |
| `parse-error` | `ScraperSchemaChangedError` — expected HTML/JSON structure not found | "Le format du site a changé. Une mise à jour de l'application est nécessaire." | Report issue (include diagnostic info) |
| `blocked`     | Cloudflare/WAF challenge not solved                                  | "Protection anti-bot activée. Réessayez plus tard."                            | Wait + retry                           |
| `absent`      | Source has no data for this film (legitimate)                        | "Pas de note sur cette source."                                                | None (not an error)                    |
| `stale`       | Cache older than 24h TTL                                             | "Données potentiellement obsolètes."                                           | Refresh                                |

## Planned improvements

### 1. DiagnosticsPanel component (high priority)

A panel opened from the header (next to ℹ️ About) that shows:

```
┌─ Diagnostics ─────────────────────────────────┐
│                                                │
│ ArveCinema v0.12.0                            │
│ Network: ● Active (fetching ratings…)         │
│                                                │
│ ── Cinemas ──────────────────────────────────│
│ ✅ Ciné Mont-Blanc (Sallanches) — OK          │
│ ✅ Ciné de Cluses (Cluses) — OK                │
│ ⚠  Ciné Château (Bonneville) — parse-error   │
│     Last error: page does not contain .hr_…    │
│     Last success: 2026-09-19 14:32              │
│ ✅ Cinéma Vox (Chamonix) — OK                  │
│                                                │
│ ── Rating sources ───────────────────────────│
│ IMDB dataset: 4h old (next refresh: 20h)      │
│ Wikidata: 0 failures                           │
│ AlloCiné: 3 blocked / 12 ok / 5 absent          │
│ RT: 1 blocked / 15 ok / 4 absent                │
│                                                │
│ ── Blocked films ────────────────────────────│
│ "The Matrix" — AlloCiné: blocked               │
│ "Inception" — RT: blocked                      │
│ "Dune" — AlloCiné: blocked, RT: blocked         │
│                                                │
│ [Copy diagnostics]  [Report issue on GitHub]   │
└────────────────────────────────────────────────┘
```

The "Copy diagnostics" button puts a structured text summary on the clipboard — ready to paste into a GitHub issue or email.

### 2. Better error categorization (medium priority)

Add a `category` field to `CinemaStatus` and rating status messages:

- `transient` — network issues, temporary server errors
- `schema-changed` — parser couldn't find expected structure → needs code fix
- `blocked` — anti-bot protection
- `stale` — cache too old

Each category gets a user-facing message with appropriate guidance (see table above).

### 3. "Report issue" workflow (low priority — needs GitHub integration)

The "Report issue" button would:

1. Copy diagnostics to clipboard
2. Open `https://github.com/SylvainSouche/arvecinema/issues/new`
3. Pre-fill the issue body with the diagnostic info (via URL query params)
