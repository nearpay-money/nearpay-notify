# nearpay-notify

> Transactional email (receipts, invoices, dunning, security alerts) with primary/fallback providers.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/notify · internal only |
| Owns | Message, Template |
| Depends on (published artifacts only) | spec, kit, email providers |
| First built in | Stage 1 (step 1.2) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/notify.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/notify.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/hld.md`

## Layout

```
nearpay-notify/
├── migrations/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── domain/
│   │   ├── message/
│   │   └── template/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── providers/
│   │   ├── fallback/
│   │   └── primary/
│   └── workers/
├── templates/
│   └── email/
├── test/
│   ├── contract/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.2)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
