# Architecture

## The one idea

An AI agent should be able to *ask* to spend money, but should never be the thing that *decides* it may. Paywarden splits every payment into two layers:

- **Intelligence layer (AI):** reads plain English, judges whether a basket matches a task, spots instructions hidden in web content, proposes remedies. Output is validated against schemas and can only *tighten* a decision.
- **Execution layer (plain code):** verifies signatures, limits, merchants, categories, quotes, expiry and the kill switch, then calls PayPal. No model call can reach a PayPal money-moving endpoint.

## Components

| Path | Responsibility |
|---|---|
| `src/domain/` | Zod schemas (mandate, proposal, quote, remedy) and record types |
| `src/mandate/` | Ed25519 signing and verification; code-rendered mandate readback |
| `src/policy/engine.ts` | The pure, deterministic rule engine and `tighten()` |
| `src/catalog/` | `CatalogPort` (merchant source of truth) and the demo catalogue |
| `src/gateway/gateway.ts` | Orchestration: authorize, approve, capture, reconcile, refund, webhooks, kill switch |
| `src/paypal/` | `PayPalPort`, the real REST client, and an offline fake |
| `src/ai/` | `AIProvider` interface; Claude provider; offline heuristic provider; injection scan |
| `src/audit/chain.ts` | Hash-chained, append-only audit log |
| `src/store/store.ts` | In-memory state (swap for a database) |
| `src/app.ts`, `src/server.ts` | Express API with separate agent and owner credentials |
| `src/lab/` | Adversarial Commerce Lab scenarios |
| `public/` | Home page and owner console (plain HTML, CSS and JS; AG Grid served from the app) |
| `scripts/` | `demo.ts` (end-to-end walkthrough) and `simulate.ts` (leaves work waiting in the console) |

## Authorization pipeline

1. **Idempotency.** The same key and payload returns the stored result. The same key with a different payload is refused. Concurrent duplicates share one in-flight promise.
2. **Catalogue verification.** Each claimed price, category, shipping and tax figure is replaced by the merchant's value, and any disagreement is a deny reason (`PRICE_DRIFT`, `CATEGORY_MISMATCH`, `SHIPPING_DRIFT`, `UNKNOWN_SKU`).
3. **Policy engine.** Mandate signature, revocation, kill switch, validity window, agent identity, currency, per-purchase limit, rolling-period budget, merchant allow-list, blocked categories, and quote match (SKUs, quantities, ceiling, single use). Any hard failure is a deny; otherwise a total above the approval threshold is `needs_approval`.
4. **AI review** (skipped if already denied). Injection scan and intent judgment. A confident "wrong item" denies; an unsure one asks a person; an error asks a person.
5. **Execution.** Authority is re-checked, then the budget and quote are reserved in one synchronous step (no `await` between check and write), then PayPal's create-order is called with the idempotency key as `PayPal-Request-Id`. If PayPal fails, the reservation is released and the same key can be retried safely.

## Invariants (each has tests)

1. A deny can never be turned into an allow by the AI, by a human approval, or by a retry.
2. Agent-supplied prices, categories and shipping are never used; only merchant values are sent to PayPal.
3. The agent cannot approve, refund, revoke, resume or freeze (separate credentials).
4. Authority is re-checked at approval and at capture, not only at the first request.
5. Two purchases cannot both spend the same last dollar of budget, or the same quote.
6. Refunds need a named human, a captured order, a positive integer amount, and never exceed what remains.
7. A failed or malformed AI answer degrades to "ask a person".
8. Editing a signed mandate invalidates it; editing, deleting or reordering audit entries breaks the chain.

## Trust boundaries

- **Untrusted:** everything the agent sends, and all merchant or web text (`untrustedContext`).
- **Trusted for facts:** the merchant catalogue (via `CatalogPort`), PayPal's verified responses and webhooks.
- **Trusted for authority:** the owner credential, and the signed mandate.

## What is simulated

`FakePayPal` mimics `PayPal-Request-Id` idempotency and the rule that an order cannot be captured before the payer approves it. It is a test double, not PayPal; real behaviour must be verified in the sandbox. The demo catalogue and the fulfilment events in the lab and demo are our own data. The offline `HeuristicProvider` is a deliberately weak, fail-closed fallback and test double, not the intended AI.

## Known gaps

See the Limitations section of the README. The most important: the gateway holds the signing key, the audit log is tamper-evident rather than tamper-proof, and state is in memory.
