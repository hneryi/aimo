# Aimo agent interface

Aimo exposes its purchasing service to external agents through the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP). An agent can search the wholesaler
assortment, read live price and availability, check allergens with evidence, get a fixed-price quote, place
an order inside the authority it was granted, hand anything else to a human, and follow the order.
Each registered agent has its own token, account and limits, and every quote and order confirmation is
signed by the server so the agent can verify it without a human.

The agent proposes. The same deterministic rules that guard the Aimo UI decide. An agent cannot order a
product that fails or lacks data for a dietary requirement, cannot exceed its authority, and cannot skip
the re-check before submission.

## One purchasing service, two transports

The kitchen assistant is the buyer's own agent. The wholesaler side provides the interface, deterministic
rules and approval gate. Weekly orders, draft orders and chat quick orders now use the same
`orders.ts: prepareQuote()` and `createOrder()` functions as external agents: verify, issue a signed
single-use quote, then consume that quote to create an order. **MCP is only the external transport.** The
kitchen assistant calls the functions in process; it does not call MCP or send HTTP to itself.

The rules still differ by authority: kitchen orders use the kitchen limit; external orders use the shared
or registered agent's limits. Chat quick orders always need confirmation, and an unsigned kitchen order
always waits when approvers are configured. Allergen, lot-size, credit and supplier-availability checks
are shared and cannot be overridden. Unstated stock quantities are currently recorded as notes for both
sources, not as approval reasons (some historical examples below predate this behaviour).

Automatic kitchen orders and `place_order` can only be created at the quoted prices within the quote's
15-minute validity. A price difference above EUR 0.005 returns `price_changed`, creates no order, and asks
for a fresh quote. The human-approval path is unchanged: approval requests, over-limit kitchen orders and
mandatory chat confirmations use fresh prices, and human approval re-checks them once more. If a price moved
since the order was shown to the approver, that click sends nothing: the order takes the new prices, stays
`pending_approval` with `recheck.ok: false` and the old and new prices in `recheck.changes`, and is sent only
after one more approval (audit action `recheck_price_changed`). The final signed confirmation records the
prices that were sent.

Kitchen quotes have `source: ui` in storage and signed recipient `{ id: "kitchen", name: "Aimo",
identity: "kitchen" }`. This is a separate owner within the account, not the shared demo token's absent
`agentId`. Neither kind of MCP credential can consume a kitchen quote, nor can the kitchen consume an
MCP quote. Kitchen retries use the existing content-based key and return the earlier order before creating
any quote, including concurrent retries.

The UI API's `Order` includes `quoteId`, `quote` (issuer, recipient, account, timestamps and the original
`signed` JWS) and, once submitted, `signedConfirmation`. Evidence is retained on the order after quote
cleanup. The order card shows it in an expandable row, verifies it in the browser with WebCrypto Ed25519
and the same-origin `/.well-known/jwks.json`, and allows viewing/copying the content and JWS. Unsupported
Ed25519, missing keys and failed verification are labelled explicitly. Quote and final confirmation prices
are compared directly: differing unit prices and totals are shown, not claimed to agree. If either signature
is not verified, the comparison is explicitly labelled unverified. An expired
quote can still have a valid signature; expiry and single-use status are shown separately. Legacy orders
without quote evidence still load and explicitly say that no quote is available.

All examples in this document are taken from real responses of a local instance on 14 Nov 2026 and
shortened for reading. Prices and availability come live from the Valio Aimo challenge mock API. Order
submission is a local simulation: the mock has no order endpoint, and nothing is sent to Valio Aimo.

## Contents

- [Transport and authentication](#transport-and-authentication)
- [Quick start with curl](#quick-start-with-curl)
- [Result and error envelope](#result-and-error-envelope)
- [Shared objects](#shared-objects)
- [Tools](#tools)
- [Order quantities and lot sizes](#order-quantities-and-lot-sizes)
- [Supplier API call budget](#supplier-api-call-budget)
- [Order lifecycle](#order-lifecycle)
- [Quotes](#quotes)
- [Idempotency](#idempotency)
- [Authority](#authority)
- [Partial availability and substitution](#partial-availability-and-substitution)
- [Error codes](#error-codes)
- [Trust and provenance](#trust-and-provenance)
- [Signed quotes and order confirmations](#signed-quotes-and-order-confirmations)
- [Human approvers](#human-approvers)
- [Audit log and hash chain](#audit-log-and-hash-chain)
- [Known limitations](#known-limitations)

## Transport and authentication

| | |
| --- | --- |
| Protocol | MCP over Streamable HTTP, JSON-RPC 2.0 |
| Endpoint | `POST <base URL>/mcp` |
| Server | `aimo-purchasing` 1.0.0, capability `tools` |
| Mode | Stateless. No session id. Every POST is handled on its own, so there is nothing to resume or close. `GET` and `DELETE` return HTTP 405. |
| Authentication | `Authorization: Bearer <agent token>`. A missing, wrong, revoked or expired token returns HTTP 401 with `WWW-Authenticate: Bearer`. |
| Required headers | `Content-Type: application/json` and `Accept: application/json, text/event-stream` |
| Response framing | `Content-Type: text/event-stream` with one event: `event: message` and a `data:` line holding the JSON-RPC response |

There are two kinds of token:

| | Registered agent | Shared demo token |
| --- | --- | --- |
| Token | `aimo-agt-…`, created by a person in the Aimo UI (menu, "Ordering limits"). Shown once, at creation. The server keeps only its SHA-256, so it cannot be read back from any endpoint or file | `AGENT_TOKEN`, or generated on first start. One token for everyone |
| Agent name | The registered name. `X-Agent-Name` is ignored | `X-Agent-Name`, self-declared and not verified (ASCII letters, digits, space, `.`, `_`, `-`, at most 40 characters; default `purchasing-agent`) |
| Account | The account the agent was registered for. `X-Aimo-Account` may be left out; any other account returns HTTP 403 | `X-Aimo-Account: school \| wedding \| hotel \| cafe` (default `school`) |
| Authority | Its own per-order limit and weekly limit, its own expiry, revocable at any time | The account's shared limit (`agentAutoLimit`, EUR 500 for `school`), no weekly limit of its own, no expiry |
| In answers | `identity: "registered"`, actor `Registered agent (<name>)` | `identity: "self_declared"`, actor `External agent (<name>)` |

The shared demo token is kept so the demo and existing integrations work unchanged. Use a registered agent
whenever it matters who is ordering.

The MCP URL is shown in the Aimo UI and returned by `GET /api/agent-info`, together with the address of the
signing key. The shared demo token is included there in open demo mode; when approvers are configured
(see [Human approvers](#human-approvers)) only a signed-in approver gets it.

Any MCP client that supports Streamable HTTP with a bearer header can connect. A typical client
configuration looks like this (the exact format depends on the client):

```json
{
  "mcpServers": {
    "aimo": {
      "type": "http",
      "url": "https://<your-aimo-host>/mcp",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}
```

The server's `initialize` result carries these instructions for the agent:

> Aimo exposes a food-service wholesaler assortment (Valio Aimo challenge data) to purchasing agents.
> Typical flow: get_authority → search_products (with requirements) → prepare_order → place_order if
> within authority, otherwise request_approval → get_order_status. Products whose requirement verdict is
> "fail" or "unknown" can never be ordered for that requirement. Prices are fixed per quote; quotes expire
> after 15 minutes and produce at most one order. Order quantities are whole sales units in multiples of
> order_multiple.

## Quick start with curl

```bash
export AIMO_URL=http://localhost:8787
export AIMO_TOKEN=<agent token>   # the examples below were recorded with the shared demo token

# initialize
curl -s -X POST "$AIMO_URL/mcp" \
  -H "Authorization: Bearer $AIMO_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Agent-Name: menu-planner-agent" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

```
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"aimo-purchasing","version":"1.0.0"},"instructions":"Aimo exposes a food-service wholesaler assortment … in multiples of order_multiple."},"jsonrpc":"2.0","id":1}
```

A small helper for tool calls:

```bash
mcp() {   # usage: mcp <tool name> '<JSON arguments>'
  curl -s -X POST "$AIMO_URL/mcp" \
    -H "Authorization: Bearer $AIMO_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Name: menu-planner-agent" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | sed -n 's/^data: //p'
}
```

The demo flow, ordering 1,000 L of lactose-free milk for Monday 16 Nov 2026:

```bash
# 1. What may I do on my own?
mcp get_authority '{}'

# 2. Quote for the need. Note the quote_id in the answer.
mcp prepare_order '{"delivery_date":"2026-11-16","requirements":["lactose_free"],"need":{"query":"laktoositon maitojuoma","amount":1000,"unit":"L"}}'

# 3. Try to place it (use your quote_id). EUR 1,010 is above the agent limit: approval_required.
mcp place_order '{"quote_id":"Q-B541504AFB","idempotency_key":"milk-2026-11-16-run-1"}'

# 4. Hand it to a human. The order appears in the Aimo UI. Note the order_id in the answer.
mcp request_approval '{"quote_id":"Q-B541504AFB","idempotency_key":"milk-2026-11-16-run-1","note":"School milk for week 47; cheapest verified lactose-free option."}'

# 5. After the human approved in the UI (use your order_id):
mcp get_order_status '{"order_id":"AIMO-2026-0002"}'
```

Because the server is stateless, a `tools/call` also works without a preceding `initialize`. Standard MCP
clients send `initialize` and `tools/list` anyway.

## Result and error envelope

A successful call returns the payload twice: as `structuredContent` (an object) and as pretty-printed JSON
text in `content[0].text`.

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "content": [ { "type": "text", "text": "{ …same JSON as text… }" } ],
              "structuredContent": { "…": "…" } } }
```

A refused call is a normal JSON-RPC result with `isError: true`. The text is a JSON object with a
machine-readable `error` code, a human-readable `message`, and sometimes extra fields:

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "isError": true,
              "content": [ { "type": "text",
                "text": "{ \"error\": \"approval_required\", \"message\": \"…\", \"reasons\": [ \"…\" ] }" } ] } }
```

Arguments that do not match a tool's input schema are rejected before the tool runs. That error is plain
text, not JSON:

```
MCP error -32602: Input validation error: Invalid arguments for tool place_order: Too small: expected string to have >=8 characters at idempotency_key
```

Every tool accepts an optional `lang` (`"fi"`, `"sv"` or `"en"`, default `"en"`) for the human-readable
strings: summaries, evidence, reasons, notes, status labels. Decide on the machine fields (`verdict`,
`suitable`, `error`, `status`, `within_agent_authority`), not on the wording.

## Shared objects

### Requirements

`gluten_free`, `wheat_free`, `lactose_free`, `milk_free`, `egg_free`, `nut_free`, `soy_free`, `fish_free`.

`gluten_free` and `wheat_free` are independent: a product with a gluten-free claim may contain gluten-free
wheat starch, which fails `wheat_free`. `lactose_free` and `milk_free` are independent: lactose-free milk
fails `milk_free`. Pass exactly the requirements the end consumer has.

### Verdicts

| Verdict | Meaning | Can be ordered for that requirement |
| --- | --- | --- |
| `ok` | Verified from supplier data | Yes |
| `fail` | Contains or may contain the allergen | No |
| `unknown` | Supplier data is missing or contradicts itself | No |

### Product

Returned by `search_products`, `get_price_availability` and `check_allergens`.

| Field | Meaning |
| --- | --- |
| `product_id` | Catalog id, used in every other call |
| `name`, `brand`, `vendor`, `gtin` | Supplier master data. `name` follows `lang` when a translation exists |
| `sales_unit` | Supplier sales unit code, for example `ST`, `BAG`, `SK`. Order quantities are in sales units |
| `pack` | `{ "amount": 10, "unit": "L" }`: physical content of one sales unit, `kg` or `L`. `null` when it cannot be derived from structured supplier data |
| `order_multiple` | Order quantities must be a multiple of this many sales units (the supplier's lot size). 1 for most products. See [Order quantities and lot sizes](#order-quantities-and-lot-sizes) |
| `ingredients` | Supplier ingredient list in the requested language when the supplier provides one, else the primary list. `null` when missing |
| `declared_allergens` | `{ contains: [], mayContain: [], freeFrom: [] }` with allergen names |
| `claims` | Regulated and marketing claims Aimo recognises, for example `Gluten-free`, `Lactose-free` |
| `supplier_data_updated` | Date the supplier last updated the product data |
| `packaging_labels` | Supplier-declared `{ id, name }[]`; common names localized fi/sv/en, untranslated ids retained, temperature markers excluded |
| `country_of_origin` | Supplier's country code, or `null` when missing |
| `packaging_label_note` | Supplier declaration disclaimer: Aimo does not independently verify certificates |
| `delivery_reliability_history` | 0 to 1, from the challenge dataset. History, not a promise. `null` when not available |
| `co2_kg_per_kg_category_average` | Category-level average from the challenge dataset, not a measured product footprint |
| `requirement_checks` | One entry per requested requirement: `requirement`, `verdict`, `summary`, `evidence[]` |
| `suitable` | `true` when every requested requirement is `ok`. Also `true` when no requirements were requested |
| `offer` | Live price and availability, see below. Absent in `check_allergens` |

Each `evidence` entry has `kind` (`declared`, `ingredient`, `claim`, `missing`, `note`), `tone` (`ok`,
`fail`, `unknown`, `info`) and `text`. Ingredient evidence quotes the supplier's primary ingredient list,
which is Finnish for almost every product, whatever `lang` is.

### Offer

| Field | Meaning |
| --- | --- |
| `price_eur_excl_vat_per_sales_unit`, `price_eur_incl_vat`, `vat_rate` | Price for one sales unit |
| `comparison_price`, `comparison_unit` | Price per kg or L as given by the supplier |
| `availability` | `available` (quantity stated), `unknown_qty` (orderable, supplier states no quantity), `unavailable` (sales block), `no_data` (no availability information or the mock API did not answer) |
| `available_sales_units` | Stated quantity, or `null` |
| `available_date` | Date the supplier can deliver |
| `order_cutoff`, `cutoff_passed` | Supplier order cutoff and whether it is already in the past |
| `note` | The same information as a sentence |
| `source` | Always `valio_mock` |
| `observed_at` | When Aimo fetched this offer from the mock API |
| `error` | Set when the mock API could not be reached. `rate_limited` while the supplier API's call budget is used up; `note` then says how many seconds to wait |

### Order

Returned by `place_order`, `request_approval` and `get_order_status`.

| Field | Meaning |
| --- | --- |
| `order_id` | For example `AIMO-2026-0002` |
| `status`, `status_label` | See [Order lifecycle](#order-lifecycle) |
| `title`, `created_by`, `delivery_date` | `created_by` contains the agent name |
| `total_excl_vat`, `vat`, `total_incl_vat` | EUR |
| `approval` | `required`, `reasons[]`, and after a decision `decidedBy` and `decidedAt` |
| `recheck` | Result of the latest fresh re-check: `at`, `ok`, `changes[]` |
| `confirmation` | Simulated confirmation number `SIM-XXXXXXXX` once submitted, else `null` |
| `quote_id`, `signed_quote` | Original quote id and retained signed quote, or `null` for legacy orders without this evidence |
| `signed_confirmation` | Signed final prices and simulated confirmation once submitted, otherwise `null` |
| `integration` | `{ prices: "valio_mock", availability: "valio_mock", submission: "local_simulation", note }` |
| `lines[]` | `product_id`, `name`, `quantity`, `unit_price_excl_vat`, `line_total_excl_vat`, `why` |
| `events[]` | Only in `get_order_status`: `at`, `actor`, `text` |

## Tools

| Tool | Purpose | Changes state |
| --- | --- | --- |
| [`get_authority`](#get_authority) | The agent's own authorisation, whether its identity is registered, the account's budget and the rules | No |
| [`search_products`](#search_products) | Catalog search with verdicts, price and availability | No |
| [`get_price_availability`](#get_price_availability) | Fresh price and availability for known product ids | No |
| [`check_allergens`](#check_allergens) | Verdicts with evidence for one product | No |
| [`prepare_order`](#prepare_order) | One fixed-price quote from explicit items, from needs, or both; also returned signed | Stores a quote |
| [`place_order`](#place_order) | Place a quoted order inside the agent's authority | Creates and submits an order |
| [`request_approval`](#request_approval) | Send a quoted order to a human | Creates a pending order |
| [`get_order_status`](#get_order_status) | Status, decision, re-check, confirmation (signed once submitted), events | No |
| [`list_orders`](#list_orders) | The 15 most recent orders | No |
| [`get_audit_log`](#get_audit_log) | Hash-chained record of actions and approvals | No |

### get_authority

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `lang` | string | no | `fi`, `sv` or `en` |

```json
{}
```

```json
{
  "agent": "menu-planner-agent",
  "identity": "self_declared",
  "identity_note": "Shared demo token: the agent name is self-declared (X-Agent-Name) and not verified, and the account is chosen with X-Aimo-Account.",
  "authorization": { "agent_id": null, "per_order_limit_excl_vat": 500, "weekly_limit_excl_vat": null, "ordered_alone_last_7_days": null, "weekly_remaining": null, "expires_at": null },
  "account": { "id": "school", "name": "Koivurinteen koulun keittiö", "kind": "school" },
  "available_accounts": [ { "id": "school", "name": "…" }, { "id": "wedding", "name": "…" }, { "id": "hotel", "name": "…" }, { "id": "cafe", "name": "…" } ],
  "account_selection": "HTTP header X-Aimo-Account: <id> (default: school)",
  "currency": "EUR",
  "per_order_limit_excl_vat": 500,
  "weekly_budget": 6000,
  "spent_this_week": 4044.74,
  "remaining_this_week": 1955.26,
  "rules": [
    { "id": "agent-limit", "effect": "auto", "text": "An external agent may order on its own up to €500.00 (excl. VAT) per order with the shared demo token; a registered agent within its own per-order and weekly limits." },
    { "id": "user-limit", "effect": "auto", "text": "A kitchen user’s order up to €1,500.00 goes out without a second approval." },
    { "id": "over-limit", "effect": "human", "text": "An order above the limit or over the weekly budget needs human approval." },
    { "id": "substitution", "effect": "human", "text": "A substitute the kitchen has not approved before needs human approval." },
    { "id": "uncertain", "effect": "human", "text": "A passed order cutoff or a quantity the supplier has not confirmed needs human approval." },
    { "id": "allergen", "effect": "never", "text": "An allergen requirement cannot be overridden: a product that fails the check or lacks data never enters an order – not for a lower price and not by approval." },
    { "id": "recheck", "effect": "never", "text": "No order is sent without re-checking price, availability and allergens. The same order is never sent twice." }
  ],
  "supported_requirements": ["gluten_free", "wheat_free", "lactose_free", "milk_free", "egg_free", "nut_free", "soy_free", "fish_free"],
  "signing": { "format": "JWS compact serialization (RFC 7515)", "alg": "EdDSA", "kid": "HgmgAUNYgZgI…", "jwks_url": "https://<your-aimo-host>/.well-known/jwks.json" },
  "provenance": {
    "catalog": "Valio Aimo Junction 2026 challenge product catalog (synthetic). Allergen verdicts are computed by deterministic rules from supplier-declared allergens, the supplier ingredient list and regulated claims; missing data yields \"unknown\", never \"ok\".",
    "prices_and_availability": "Valio Aimo challenge mock API (POST /api/price, POST /api/availability), fetched live; each offer carries observedAt.",
    "order_submission": "LOCAL SIMULATION. The challenge mock API has no order endpoint; nothing is sent to Valio Aimo.",
    "signatures": "signed_quote and signed_confirmation are signed by this Aimo server (EdDSA). A valid signature proves that this server issued exactly that content and that it was not altered. It does not prove that the Valio Aimo mock data behind the figures is correct: the mock does not sign its answers."
  }
}
```

`effect` is `auto` (allowed without a human), `human` (needs approval) or `never` (cannot be overridden).

A registered agent gets its own authorisation instead. The same call with the token of an agent registered
for the `hotel` account with EUR 100 per order and EUR 150 per week, after it ordered EUR 140 on its own
(local run against the offline stub of the mock):

```json
{
  "agent": "hotel-bot",
  "identity": "registered",
  "identity_note": "Registered agent: the name and the account come from the bearer token. X-Agent-Name is ignored and another account in X-Aimo-Account is refused.",
  "authorization": {
    "agent_id": "ag-3f9a1c2e",
    "per_order_limit_excl_vat": 100,
    "weekly_limit_excl_vat": 150,
    "ordered_alone_last_7_days": 140,
    "weekly_remaining": 10,
    "expires_at": "2026-12-14T19:02:11.201Z"
  },
  "account": { "id": "hotel", "name": "Hotelli Majakka · ravintola", "kind": "restaurant" },
  "available_accounts": [ { "id": "hotel", "name": "Hotelli Majakka · ravintola" } ],
  "account_selection": "Fixed by the bearer token.",
  "per_order_limit_excl_vat": 100,
  "weekly_budget": 12000,
  "rules": [
    { "id": "agent-limit", "effect": "auto", "text": "The agent hotel-bot may order on its own up to €100.00 (excl. VAT) per order and up to €150.00 within seven days." },
    { "…": "the other rules as above" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `identity` | `registered`: name and account come from the token. `self_declared`: the shared demo token, the name is whatever `X-Agent-Name` said |
| `authorization.per_order_limit_excl_vat` | The largest order the agent may place alone. Also returned as the top-level `per_order_limit_excl_vat` |
| `authorization.weekly_limit_excl_vat` | The most the agent may order alone within 7 days. `null` for the shared demo token |
| `authorization.ordered_alone_last_7_days`, `weekly_remaining` | What it has already ordered on its own authority in the last 7 days, and what is left. Orders a person approved do not count: that was the person's decision |
| `authorization.expires_at` | When the grant ends. After that, or after a person revokes it, the token gets HTTP 401 |
| `weekly_budget`, `credit_*` | The account's own budget and credit limit. They apply on top of the agent's limits |

### search_products

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string, min 2 chars | yes | Search words. The catalog is Finnish; Swedish and English product names and brands also match. Every word must occur in the name or brand |
| `requirements` | string[] | no | Requirements to check each product against |
| `delivery_date` | `YYYY-MM-DD` | no | Default: next Monday |
| `only_suitable` | boolean | no | Return only products that are `ok` for all requirements |
| `limit` | integer 1–20 | no | Default 8 |
| `lang` | string | no | |

```json
{ "query": "laktoositon maitojuoma", "requirements": ["lactose_free"], "delivery_date": "2026-11-16", "only_suitable": true, "limit": 2 }
```

```json
{
  "query": "laktoositon maitojuoma",
  "requirements": ["lactose_free"],
  "delivery_date": "2026-11-16",
  "count": 2,
  "products": [
    {
      "product_id": "463335",
      "name": "Valio Eila® 3 % milk drink 1 l lactose free",
      "brand": "Valio",
      "vendor": "VALIO OY TUORE",
      "gtin": "6408430000296",
      "sales_unit": "ST",
      "pack": { "amount": 1, "unit": "L" },
      "ingredients": "MILK, vitamin D.",
      "declared_allergens": { "contains": ["milk"], "mayContain": [], "freeFrom": [] },
      "claims": ["Lactose-free", "Vegetarian"],
      "supplier_data_updated": "2025-09-29",
      "delivery_reliability_history": 1,
      "co2_kg_per_kg_category_average": 1.1,
      "requirement_checks": [
        {
          "requirement": "lactose_free",
          "verdict": "ok",
          "summary": "Suitable: lactose-free. Verified from supplier data.",
          "evidence": [
            { "kind": "claim", "tone": "ok", "text": "Supplier claim: lactose-free." },
            { "kind": "declared", "tone": "info", "text": "Note: the product contains milk – lactose-free does not mean milk-free." }
          ]
        }
      ],
      "suitable": true,
      "offer": {
        "price_eur_excl_vat_per_sales_unit": 1.4,
        "price_eur_incl_vat": 1.59,
        "vat_rate": 13.5,
        "comparison_price": 1.4,
        "comparison_unit": "L",
        "availability": "unknown_qty",
        "available_sales_units": null,
        "available_date": "2026-11-16",
        "order_cutoff": "2026-11-15T17:00:00+0200",
        "cutoff_passed": false,
        "note": "Orderable for Mon 16 Nov · quantity not stated (terminal product)",
        "source": "valio_mock",
        "observed_at": "2026-11-14T18:15:24.476Z",
        "error": null
      }
    },
    { "product_id": "469119", "…": "…" }
  ],
  "provenance": { "…": "as in get_authority" }
}
```

Results are ordered by name relevance, not by verdict or price. Offers in search results may come from a
cache of up to 60 seconds; `observed_at` shows their age.

### get_price_availability

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `product_ids` | string[], 1–30 | yes | |
| `delivery_date` | `YYYY-MM-DD` | yes | |
| `lang` | string | no | |

Always fetches fresh data from the mock API.

```json
{ "product_ids": ["474235", "999999"], "delivery_date": "2026-11-16" }
```

```json
{
  "delivery_date": "2026-11-16",
  "offers": [
    {
      "product_id": "474235",
      "name": "SamMills Pasta D'oro 5kg macaroni glutenfree pasta",
      "sales_unit": "ST",
      "pack": { "amount": 5, "unit": "kg" },
      "…": "other product fields",
      "requirement_checks": [],
      "suitable": true,
      "offer": {
        "price_eur_excl_vat_per_sales_unit": 22.92,
        "price_eur_incl_vat": 26.01,
        "vat_rate": 13.5,
        "comparison_price": 4.58,
        "comparison_unit": "KG",
        "availability": "available",
        "available_sales_units": 19,
        "available_date": "2026-11-16",
        "order_cutoff": "2026-11-15T17:00:00+0200",
        "cutoff_passed": false,
        "note": "Available for Mon 16 Nov · 19 in stock",
        "source": "valio_mock",
        "observed_at": "2026-11-14T18:16:33.110Z",
        "error": null
      }
    },
    { "product_id": "999999", "error": "unknown_product" }
  ],
  "provenance": { "…": "as in get_authority" }
}
```

This tool takes no requirements, so `requirement_checks` is empty and `suitable` carries no information
here.

### check_allergens

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `product_id` | string | yes | |
| `requirements` | string[] | no | Default: all eight |
| `lang` | string | no | |

```json
{ "product_id": "467032", "requirements": ["gluten_free", "wheat_free"] }
```

```json
{
  "product_id": "467032",
  "name": "Fria White bread 500g glutenfree frozen skiced x 6",
  "brand": "Fria",
  "vendor": "FRIA BRÖD AB",
  "gtin": "7330242240012",
  "sales_unit": "BAG",
  "pack": { "amount": 0.5, "unit": "kg" },
  "ingredients": "GLUTEN FREE WHEAT STRACH, water, GLUTEN FREE MALT EXTRACT (BARLEY), thickeners (…), yeast, rapeseed oil, sugar, … MAY CONTAIN TRACES OF EGGS.",
  "declared_allergens": {
    "contains": [],
    "mayContain": ["egg"],
    "freeFrom": ["crustaceans", "fish", "milk", "tree nuts", "peanut", "sesame", "sulphites", "cereals containing gluten", "soy", "celery", "mustard", "lupin", "molluscs"]
  },
  "claims": ["Gluten-free", "Lactose-free"],
  "supplier_data_updated": "2025-05-28",
  "delivery_reliability_history": 1,
  "co2_kg_per_kg_category_average": 1.44,
  "requirement_checks": [
    {
      "requirement": "gluten_free",
      "verdict": "ok",
      "summary": "Suitable: gluten-free. Verified from supplier data.",
      "evidence": [
        { "kind": "claim", "tone": "ok", "text": "Supplier claim: gluten-free (regulated claim, below 20 mg/kg gluten)." },
        { "kind": "ingredient", "tone": "info", "text": "Contains gluten-free wheat starch (”GLUTEENITON VEHNÄTÄRKKELYS”) – not suitable for a wheat-free diet." }
      ]
    },
    {
      "requirement": "wheat_free",
      "verdict": "fail",
      "summary": "Not suitable: wheat-free. In the ingredient list: ”GLUTEENITON VEHNÄTÄRKKELYS”. Gluten-free wheat starch is still derived from wheat – fine for a gluten-free diet, not for a wheat-free one.",
      "evidence": [
        { "kind": "ingredient", "tone": "fail", "text": "In the ingredient list: ”GLUTEENITON VEHNÄTÄRKKELYS”. Gluten-free wheat starch is still derived from wheat – fine for a gluten-free diet, not for a wheat-free one." },
        { "kind": "claim", "tone": "info", "text": "The product carries a gluten-free claim. That says nothing about wheat, so it is not used for this check." }
      ]
    }
  ],
  "suitable": false,
  "provenance": "Valio Aimo Junction 2026 challenge product catalog (synthetic). Allergen verdicts are computed by deterministic rules …"
}
```

The supplier declares this bread free from gluten cereals, and it carries a gluten-free claim. The
ingredient list still shows wheat starch, so the wheat-free check fails. This is the case the interface is
built to catch.

### prepare_order

Builds one quote for a whole order. Give `items`, `needs`, `need`, or a combination: everything ends up in
the same quote and, later, in one order. Lines for the same product are merged.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `delivery_date` | `YYYY-MM-DD` | yes | |
| `requirements` | string[] | no | Applied to every line |
| `items` | `{ product_id, quantity, substitute_for? }[]` | one of | `quantity` is a positive integer of sales units and a multiple of the product's `order_multiple`. It is never changed for you: a quantity off the lot is refused |
| `needs` | need[], 1–20 | one of | Needs to source, see below. Each is sourced on its own |
| `need` | need | one of | A single need. Same as `needs` with one entry |
| `lang` | string | no | |

A need:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Product type in catalog words, for example `laktoositon maitojuoma` |
| `amount` | number > 0 | yes | Physical amount |
| `unit` | `L`, `kg` or `pcs` | yes | Pieces use the supplier's structured pieces per sales unit |
| `product_id` | string | no | Restrict to one product. A shortfall is reported, with informational `substitute_options`, never filled silently |
| `substitute_for` | string | no | Existing, different product being replaced; applies to each allocated line. Also available on each `items` entry |

```json
{ "delivery_date": "2026-11-16", "requirements": ["lactose_free"],
  "need": { "query": "laktoositon maitojuoma", "amount": 1000, "unit": "L" } }
```

```json
{
  "quote_id": "Q-B541504AFB",
  "expires_at": "2026-11-14T18:30:25.181Z",
  "content_sha256": "dbaa03d70fb828edfd9bcaa0c1c23bb894a7674a600fa9db5b1932a62224b582",
  "delivery_date": "2026-11-16",
  "requirements": ["lactose_free"],
  "currency": "EUR",
  "lines": [
    {
      "product_id": "464306",
      "name": "Valio Hyvä suomalainen Arki® Eila® semi skimmed milk drink 1 l lactose free",
      "quantity": 1000,
      "sales_unit": "ST",
      "pack": { "amount": 1, "unit": "L" },
      "unit_price_excl_vat": 1.01,
      "line_total_excl_vat": 1010,
      "why": "Cheapest product meeting the requirements (€1.01/L).",
      "requirement_checks": [
        { "requirement": "lactose_free", "verdict": "ok", "summary": "Suitable: lactose-free. Verified from supplier data." }
      ]
    }
  ],
  "total_excl_vat": 1010,
  "vat": 136.35,
  "total_incl_vat": 1146.35,
  "fulfilment": { "requested": 1000, "covered": 1000, "shortfall": 0, "unit": "L", "split_across_products": 1 },
  "ranked_options": [
    { "product_id": "464306", "name": "Valio Hyvä suomalainen Arki® Eila® semi skimmed milk drink 1 l lactose free",
      "roles": [{ "role": "cheapest", "label": "Cheapest" }, { "role": "most_reliable", "label": "Most reliable" }],
      "basis": { "cost_to_cover_eur_excl_vat": 1010, "sales_units": 1000, "covered_amount": 1000,
        "delivery_reliability_history": 1, "packaging_labels": ["GOODS_FROM_FINLAND_BLUE_SWAN"],
        "country_of_origin": "fi", "co2_kg_per_kg_category_average": 1.1 },
      "availability": "unknown_qty", "delivery_reliability_history": 1 }
  ],
  "excluded_by_rules": { "failed": 0, "unknown": 0, "examples": [] },
  "within_agent_authority": false,
  "approval_required_because": [
    "Total €1,010.00 exceeds the agent’s ordering authority of €500.00."
  ],
  "next_step": "request_approval",
  "provenance": { "…": "as in get_authority" }
}
```

The answer also carries `signed_quote`, the same commitment as a signed JWS, and `signature`, which says how
to verify it. See [Signed quotes and order confirmations](#signed-quotes-and-order-confirmations).

The price example above retains the recorded quote figures; its option fields illustrate the current
schema, not a fresh live run. This milk has an origin label, not an environmental label, so it does not
qualify for the sustainability role under the rule below.

`fulfilment`, `ranked_options` and `excluded_by_rules` are present when the call had exactly one need.
`next_step` is `place_order` when `within_agent_authority` is `true`, otherwise `request_approval`.
Every line also carries `order_multiple`, and the quote says `single_use: true`.

Whenever the call had needs, `fulfilment_by_need` reports each of them in the order given:

```json
{ "delivery_date": "2026-11-16",
  "needs": [ { "query": "riisi", "amount": 20, "unit": "kg" },
             { "query": "ruokakerma", "amount": 10, "unit": "L" },
             { "query": "yksisarvinen", "amount": 5, "unit": "kg" } ],
  "items": [ { "product_id": "474235", "quantity": 2 } ] }
```

```json
"fulfilment_by_need": [
  { "query": "riisi", "status": "covered", "requested": 20, "covered": 20, "shortfall": 0, "unit": "kg",
    "split_across_products": 1, "lines": [ { "product_id": "468026", "quantity": 2 } ],
    "ranked_options": [ { "…": "…" } ], "excluded_by_rules": { "failed": 0, "unknown": 0, "examples": [] } },
  { "query": "ruokakerma", "status": "covered", "requested": 10, "covered": 10, "shortfall": 0, "unit": "L", "…": "…" },
  { "query": "yksisarvinen", "status": "not_found", "requested": 5, "covered": 0, "shortfall": 5, "unit": "kg",
    "split_across_products": 0, "lines": [], "ranked_options": [], "excluded_by_rules": { "failed": 0, "unknown": 0, "examples": [] } }
]
```

`status` is `covered`, `partial` (a shortfall remains), `not_found`, or **`selection_required`**.
The latter means the query could refer to different product types or an unrequested material variant
(e.g. alcohol-free rather than unspecified beer). It carries `selection_reason`, verified `ranked_options`,
`lines: []`, `covered: 0` and the full requested `shortfall`. Choose a product explicitly or refine the query;
no ambiguous product is silently allocated. `not_found` and `selection_required` do not stop other needs.
If the whole call yields no lines, the error is `selection_required` when any need requires selection,
otherwise `no_suitable_product`; both retain `fulfilment_by_need` and create no quote. The product ids and quantities above come from an
offline test run against a stub, not from the live mock.

A quote with explicit items that is inside the agent's authority:

```json
{ "delivery_date": "2026-11-16", "requirements": ["gluten_free", "wheat_free"],
  "items": [ { "product_id": "474235", "quantity": 2 } ] }
```

```json
{
  "quote_id": "Q-F618CF1468",
  "expires_at": "2026-11-14T18:31:21.425Z",
  "content_sha256": "5981f2fdfcebeed5e42ad8b0c7118992d854b2cf664128f417cbc637bc1217d5",
  "delivery_date": "2026-11-16",
  "requirements": ["gluten_free", "wheat_free"],
  "currency": "EUR",
  "lines": [ { "product_id": "474235", "name": "SamMills Pasta D'oro 5kg macaroni glutenfree pasta", "quantity": 2, "sales_unit": "ST", "pack": { "amount": 5, "unit": "kg" }, "unit_price_excl_vat": 22.92, "line_total_excl_vat": 45.84, "requirement_checks": [ { "requirement": "gluten_free", "verdict": "ok", "summary": "…" }, { "requirement": "wheat_free", "verdict": "ok", "summary": "…" } ] } ],
  "total_excl_vat": 45.84,
  "vat": 6.19,
  "total_incl_vat": 52.03,
  "within_agent_authority": true,
  "approval_required_because": [],
  "next_step": "place_order",
  "provenance": { "…": "…" }
}
```

A quote is refused when any line breaks a rule. Example: a gluten-free flour mix requested as wheat-free.

```json
{
  "error": "rejected_by_rules",
  "message": "Sunnuntai 1kg dark gluten free flour mix: Not suitable: wheat-free. In the ingredient list: ”Gluteeniton VEHNÄtärkkelys”. Gluten-free wheat starch is still derived from wheat – fine for a gluten-free diet, not for a wheat-free one.",
  "blockers": [ "Sunnuntai 1kg dark gluten free flour mix: Not suitable: wheat-free. …" ]
}
```

### place_order

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `quote_id` | string | yes | From `prepare_order` |
| `idempotency_key` | string, min 8 chars | yes | Unique per intended order |
| `lang` | string | no | |

Steps, in this order:

1. If the key already belongs to an order, that order is returned with `duplicate: true`.
2. The quote is loaded. An unknown or expired quote is refused, and so is a quote that already produced an
   order (`quote_already_used`).
3. Price, availability and allergens are checked again with fresh data.
   A broken rule returns `rejected_by_rules`. A price that differs from the quote by more than EUR 0.005
   returns `price_changed`. An order outside the agent's authority returns `approval_required` and the
   attempt is written to the audit log. In all three cases no order is created.
4. Otherwise the order is created, approved by the rules and submitted (simulated). The answer carries
   `signed_confirmation`: the order confirmation as a signed JWS.

```json
{ "quote_id": "Q-F618CF1468", "idempotency_key": "gf-pasta-week47-0001" }
```

```json
{
  "duplicate": false,
  "order": {
    "order_id": "AIMO-2026-0003",
    "status": "submitted",
    "status_label": "Sent (simulation)",
    "title": "Agent order: 1 items",
    "created_by": "External agent (menu-planner-agent)",
    "delivery_date": "2026-11-16",
    "total_excl_vat": 45.84,
    "vat": 6.19,
    "total_incl_vat": 52.03,
    "approval": { "required": false, "reasons": [], "decidedBy": "Aimo rules", "decidedAt": "2026-11-14T18:16:21.642Z" },
    "recheck": { "at": "2026-11-14T18:16:21.642Z", "ok": true, "changes": [] },
    "confirmation": "SIM-10D7CE17",
    "signed_confirmation": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6Ik…",
    "integration": {
      "prices": "valio_mock",
      "availability": "valio_mock",
      "submission": "local_simulation",
      "note": "Prices and availability came from the Valio Aimo challenge API (mock) – a real integration. Order submission is a local simulation: the challenge API has no order endpoint, so nothing was sent to Valio Aimo."
    },
    "lines": [ { "product_id": "474235", "name": "SamMills Pasta D'oro 5kg macaroni glutenfree pasta", "quantity": 2, "unit_price_excl_vat": 22.92, "line_total_excl_vat": 45.84 } ]
  }
}
```

Outside the agent's authority:

```json
{
  "error": "approval_required",
  "message": "This order is outside the agent’s authority. Call request_approval to send it to a human.",
  "reasons": [
    "Total €1,010.00 exceeds the agent’s ordering authority of €500.00.",
    "The supplier does not state an available quantity for 1 products (terminal product)."
  ]
}
```

### request_approval

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `quote_id` | string | yes | From `prepare_order`, still valid |
| `idempotency_key` | string, min 8 chars | yes | The key of a refused `place_order` attempt can be reused |
| `note` | string, max 400 chars | no | Why the agent proposes the order. Shown to the approver |
| `lang` | string | no | |

Creates the order in `pending_approval`. It appears in the Aimo UI with the agent's name, the note and
every rule-based reason. The agent can use this tool for any quote, including one it could place itself.
A quote that already produced an order is refused with `quote_already_used`, unless the call repeats the key
of that order while it is still open or submitted (then the order is returned with `duplicate: true`).

```json
{ "quote_id": "Q-B541504AFB", "idempotency_key": "milk-2026-11-16-run-1",
  "note": "School milk for week 47; cheapest verified lactose-free option." }
```

```json
{
  "duplicate": false,
  "order": {
    "order_id": "AIMO-2026-0002",
    "status": "pending_approval",
    "status_label": "Waiting for approval",
    "title": "Agent order: 1000 L laktoositon maitojuoma",
    "created_by": "External agent (menu-planner-agent)",
    "delivery_date": "2026-11-16",
    "total_excl_vat": 1010,
    "vat": 136.35,
    "total_incl_vat": 1146.35,
    "approval": {
      "required": true,
      "reasons": [
        "The external agent (menu-planner-agent) asks for your approval. “School milk for week 47; cheapest verified lactose-free option.”",
        "Total €1,010.00 exceeds the agent’s ordering authority of €500.00.",
        "The supplier does not state an available quantity for 1 products (terminal product)."
      ]
    },
    "recheck": { "at": "2026-11-14T18:15:37.826Z", "ok": true, "changes": [] },
    "confirmation": null,
    "integration": { "prices": "valio_mock", "availability": "valio_mock", "submission": "local_simulation", "note": "…" },
    "lines": [ { "product_id": "464306", "name": "Valio Hyvä suomalainen Arki® Eila® semi skimmed milk drink 1 l lactose free", "quantity": 1000, "unit_price_excl_vat": 1.01, "line_total_excl_vat": 1010, "why": "Cheapest product meeting the requirements (€1.01/L)." } ]
  },
  "next_step": "A human decides in the Aimo UI. Poll get_order_status."
}
```

There is no callback. Poll `get_order_status`. `signed_confirmation` is `null` until the order has been
submitted; after the approval it is returned by `get_order_status` and names the approver.

### get_order_status

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `order_id` | string | yes | |
| `lang` | string | no | |

```json
{ "order_id": "AIMO-2026-0002" }
```

After the human approved in the UI:

```json
{
  "order": {
    "order_id": "AIMO-2026-0002",
    "status": "submitted",
    "status_label": "Sent (simulation)",
    "title": "Agent order: 1000 L laktoositon maitojuoma",
    "created_by": "External agent (menu-planner-agent)",
    "delivery_date": "2026-11-16",
    "total_excl_vat": 1010,
    "vat": 136.35,
    "total_incl_vat": 1146.35,
    "approval": {
      "required": true,
      "reasons": [ "The external agent (menu-planner-agent) asks for your approval. “…”", "Total €1,010.00 exceeds the agent’s ordering authority of €500.00.", "The supplier does not state an available quantity for 1 products (terminal product)." ],
      "decidedBy": "Kitchen manager",
      "decidedAt": "2026-11-14T18:15:46.739Z"
    },
    "recheck": { "at": "2026-11-14T18:15:46.739Z", "ok": true, "changes": [] },
    "confirmation": "SIM-6E28EBB8",
    "integration": { "prices": "valio_mock", "availability": "valio_mock", "submission": "local_simulation", "note": "…" },
    "lines": [ { "product_id": "464306", "name": "…", "quantity": 1000, "unit_price_excl_vat": 1.01, "line_total_excl_vat": 1010, "why": "Cheapest product meeting the requirements (€1.01/L)." } ],
    "events": [
      { "at": "2026-11-14T18:15:37.826Z", "actor": "External agent (menu-planner-agent)", "text": "Order prepared: 1 lines, €1,010.00 (excl. VAT). Prices, availability and allergens checked." },
      { "at": "2026-11-14T18:15:37.826Z", "actor": "Aimo rules", "text": "Needs human approval: The external agent (menu-planner-agent) asks for your approval. “…” Total €1,010.00 exceeds the agent’s ordering authority of €500.00. The supplier does not state an available quantity for 1 products (terminal product)." },
      { "at": "2026-11-14T18:15:46.739Z", "actor": "Kitchen manager", "text": "Approved. Prices, availability and allergens were re-checked right before sending – no changes." },
      { "at": "2026-11-14T18:15:46.984Z", "actor": "Aimo", "text": "Order recorded in the local simulation, confirmation SIM-6E28EBB8. Nothing was sent to Valio Aimo." }
    ]
  }
}
```

### list_orders

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `lang` | string | no | |

Returns the 15 most recent orders of the kitchen, newest first, from every source (UI and agents).

```json
{
  "orders": [
    { "order_id": "AIMO-2026-0003", "status": "submitted", "title": "Agent order: 1 items", "created_by": "External agent (menu-planner-agent)", "delivery_date": "2026-11-16", "total_excl_vat": 45.84, "approval_required": false },
    { "order_id": "AIMO-2026-0002", "status": "submitted", "title": "Agent order: 1000 L laktoositon maitojuoma", "created_by": "External agent (menu-planner-agent)", "delivery_date": "2026-11-16", "total_excl_vat": 1010, "approval_required": true },
    { "order_id": "AIMO-2026-0001", "status": "submitted", "title": "Weekly order · Week 47 · 16 Nov – 20 Nov", "created_by": "Kitchen manager", "delivery_date": "2026-11-16", "total_excl_vat": 4044.74, "approval_required": true }
  ]
}
```

### get_audit_log

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `order_id` | string | no | Only entries of this order |
| `limit` | integer 1–100 | no | Default 30 |
| `lang` | string | no | |

```json
{ "order_id": "AIMO-2026-0002" }
```

```json
{
  "hash_chain": "sha256(previous_hash + entry); hashes shown truncated to 16 hex chars",
  "entries": [
    { "id": "a17", "at": "2026-11-14T18:15:46.984Z", "actor": "Aimo", "action": "order_submitted", "text": "Order AIMO-2026-0002 sent (local simulation), confirmation SIM-6E28EBB8, €1,010.00.", "orderId": "AIMO-2026-0002", "hash": "6c11cea254dd768c" },
    { "id": "a16", "at": "2026-11-14T18:15:46.983Z", "actor": "Kitchen manager", "action": "order_approved", "text": "Order AIMO-2026-0002 approved (€1,010.00).", "orderId": "AIMO-2026-0002", "hash": "5765184681a524f3" },
    { "id": "a15", "at": "2026-11-14T18:15:37.890Z", "actor": "Aimo rules", "action": "duplicate_prevented", "text": "The same order already exists (AIMO-2026-0002) – no new order was created.", "orderId": "AIMO-2026-0002", "hash": "cb390222f48e0e0d" },
    { "id": "a14", "at": "2026-11-14T18:15:37.827Z", "actor": "Aimo rules", "action": "approval_required", "text": "Order AIMO-2026-0002 waits for approval: The external agent (menu-planner-agent) asks for your approval. “…” Total €1,010.00 exceeds the agent’s ordering authority of €500.00. …", "orderId": "AIMO-2026-0002", "hash": "31cb8c834e8f09fe" },
    { "id": "a13", "at": "2026-11-14T18:15:37.826Z", "actor": "External agent (menu-planner-agent)", "action": "order_created", "text": "Order AIMO-2026-0002 created: Agent order: 1000 L laktoositon maitojuoma, €1,010.00.", "orderId": "AIMO-2026-0002", "hash": "4f00e3f7496fcdb0" }
  ]
}
```

Entries are newest first. Entries that are not tied to one order, such as `quote_prepared` and
`agent_blocked`, appear only when `order_id` is omitted.

## Accounts, credit limit and units

- **Account selection.** A registered agent is bound to one account by its token; a different `X-Aimo-Account` returns HTTP 403. The shared demo token can act for every account: send `X-Aimo-Account: school | wedding | hotel` with every MCP request (default `school`). `get_authority` returns the active `account`, the `available_accounts`, and that account's limits. Orders, quotes and the audit log are per account.
- **Credit limit.** `get_authority` returns `credit_limit_incl_vat` (null when the account has no credit limit), `credit_used` and `credit_available`. An order that would exceed the credit limit is refused by `prepare_order`, `place_order` and `request_approval` with `rejected_by_rules`; human approval cannot override it.
- **Units for a need.** `prepare_order.need.unit` accepts `L`, `kg` and `pcs` (pieces: bottles, cans, packs). Pieces are converted to sales units with the supplier's unit data, e.g. 70 pcs of a product sold in cases of 24 becomes 3 cases; `fulfilment.covered` then reports 72. `covered` is always what the quoted sales units really contain, so whole packs and lot sizes can make it larger than `requested`.
- **No customer-type restrictions.** Any account may order any product in the assortment; the rules enforce dietary requirements, authority and credit, nothing else.

## Order quantities and lot sizes

Quantities are whole sales units. `order_multiple` on every product and quote line says which quantities the
supplier's lot size (`allowedLotSize` in the challenge data) allows:

- Most products have `order_multiple: 1`. Valio Aimo confirmed that a lot size of 0.01 means 1.
- 624 products, almost all sold by the kilogram, have a larger step: a lot of 2 allows 2, 4, 6 …
- Fractional lots are read cautiously (our assumption): the quantity must be a whole number of sales units
  and a multiple of the lot, so a lot of 1.5 gives `order_multiple: 3` and a lot of 2.5 gives 5.

For a need, Aimo rounds up to the next allowed quantity and says so in the line's `why`; stated availability
is rounded down to the lot. Explicit `items` are never changed. A quantity off the lot is refused:

```json
{ "error": "rejected_by_rules",
  "message": "Atria Kypsä Karjalanpaisti n2kg/24x24mm: sold in lots of 2 sales units, so a quantity of 3 is not allowed. The nearest allowed quantities are 2 and 4.",
  "blockers": [ "…" ] }
```

## Supplier API call budget

The Valio Aimo mock blocks a caller for 30 seconds after more than 10 calls per second. Aimo paces all its
calls to at most 5 per second and, after an HTTP 429, does not call the mock until the cooldown has passed
(`Retry-After` when sent, else 30 s, at most 300 s). During the cooldown:

- `prepare_order`, `place_order` and `request_approval` return `supplier_rate_limited` with
  `retry_after_seconds`. No quote and no order is created. A human approval keeps the order `pending_approval`
  with `recheck.ok: false`.
- `search_products` and `get_price_availability` still answer. Offers have `error: "rate_limited"` and a
  `note` with the wait, or are the last offer seen (check `observed_at`).

```json
{ "error": "supplier_rate_limited",
  "message": "The Valio Aimo API rate limit was hit. Try again in 28 seconds. Nothing is created or sent on stale data.",
  "retry_after_seconds": 28 }
```

Wait and call again; do not loop.

## Order lifecycle

```
 prepare_order ──► QUOTE   fixed prices · expires after 15 minutes · content_sha256
                     │
        ┌────────────┴─────────────────────────┐
        ▼                                      ▼
   place_order                          request_approval
   fresh re-check                       fresh re-check
        │                                      │
        ├─ rule broken ──► rejected_by_rules   ├─ rule broken ──► rejected_by_rules
        ├─ price moved ──► price_changed       │                  (no order)
        ├─ outside authority                   ▼
        │        ──► approval_required   ORDER  pending_approval
        │            (no order, audited)       │
        ▼                                      │  human decides in the Aimo UI
   ORDER created,                 ┌────────────┼──────────────┐
   approved by the rules          ▼            ▼              ▼
        │                      approve       reject         cancel
        │                   fresh re-check     │              │
        │                      │      │        ▼              ▼
        │                      │      └─ rule broken:      rejected      cancelled
        │                      │         stays pending,
        ▼                      ▼         recheck.ok = false
   submitted ◄─────────────────┘
   LOCAL SIMULATION · confirmation SIM-XXXXXXXX
```

| Status | Meaning |
| --- | --- |
| `pending_approval` | Waiting for a human in the Aimo UI |
| `submitted` | Recorded in the local simulation with a confirmation number. Final |
| `rejected` | A human rejected it. Nothing was sent. Final |
| `cancelled` | A human cancelled it. Nothing was sent. Final |
| `approved` | Defined in the contract but not observable today: approval and simulated submission happen in one step |

Approval is not a rubber stamp. When the human approves, Aimo fetches price and availability again and
re-runs the allergen checks. If a rule is now broken (a product became unavailable, the quantity exceeds
stock, the mock API does not answer), the order stays `pending_approval`, `recheck.ok` is `false` and
`recheck.changes` lists what blocked it. If only a price moved, the order is submitted at the current
price and the change is listed in `recheck.changes` and in the events.

Agents cannot approve, reject or cancel orders.

## Quotes

- A quote fixes the lines, quantities and unit prices observed when it was prepared.
- It is returned in plain JSON and as `signed_quote`, a JWS signed by the server
  (see [Signed quotes and order confirmations](#signed-quotes-and-order-confirmations)).
- A quote belongs to its account and recipient. Kitchen quotes, registered-agent quotes and shared-demo
  quotes have separate owners. To a different owner it does not exist ("Quote not found."). Quotes made
  with the shared demo token are shared by its users, as before; they never include kitchen quotes.
- It expires 15 minutes after creation (`expires_at`). An expired or unknown quote returns
  `rejected_by_rules` with the message "The quote has expired – prepare a new one." or "Quote not found."
- `content_sha256` is the SHA-256 of the quote's stored JSON content: agent name, request text, delivery
  date, lines (product id, quantity, unit price, requirements, reason), net total, VAT and shortfall. It
  lets the agent or an auditor refer to exactly what was quoted. The server does not ask for it back.
- `place_order` refuses with `price_changed` when the live price differs from the quote.
  `request_approval` does not refuse on a price difference: the order is created at the current price and
  the difference is listed in `recheck.changes` for the approver.
- A quote is single-use: it produces at most one order. Once `place_order` or `request_approval` created an
  order from it, any call with another idempotency key returns `quote_already_used` with `order_id` and
  `order_status`, and the attempt is written to the audit log (`quote_reuse_blocked`).
- The quote stays used when that order is rejected or cancelled. A human said no to exactly this content, so
  a new attempt needs a new `prepare_order` with fresh prices.
- A refused `place_order` (`approval_required`, `price_changed`, `rejected_by_rules`,
  `supplier_rate_limited`) created no order and leaves the quote usable.
- At most 50 quotes are kept. Expired quotes are removed after an hour.

## Idempotency

- `place_order` and `request_approval` require an `idempotency_key` of at least 8 characters. Choose one
  per intended order and reuse it on every retry.
- Repeating a call with a key that already has an order returns that order with `duplicate: true`. No
  second order is created. `request_approval` also records the prevented duplicate in the audit log.
- A new key does not get a second order out of the same quote: see [Quotes](#quotes).
- A `place_order` attempt that was refused (`approval_required`, `price_changed`, `rejected_by_rules`)
  creates no order, so the same key can be used for the following `request_approval`.
- Approving an already submitted order does nothing. An order is never submitted twice.
- A registered agent's keys are its own: another agent using the same key never gets this agent's order.
  Keys are shared by everyone using the shared demo token; prefix them with something unique to your agent.
- Orders created from the Aimo UI are deduplicated by content (delivery date, products, quantities)
  instead of a client key. This happens before quote preparation, so a retry creates neither another
  order nor another quote. Rejected/cancelled kitchen orders can be retried with a fresh quote.

## Authority

`within_agent_authority` is `false`, and `place_order` returns `approval_required`, when any of these
holds:

| Reason | Detail |
| --- | --- |
| Order total above the agent limit | `per_order_limit_excl_vat` in `get_authority`: the registered agent's own limit, or the account's shared limit for the demo token (EUR 500 for `school`) |
| The agent's weekly limit would be exceeded | Registered agents only. Counts what the agent ordered on its own authority in the last 7 days |
| Weekly budget of the account would be exceeded | Submitted orders of all sources count |
| Order cutoff has passed | For any line. In the server's strict mode (`CUTOFF_MODE=enforce`) this is `rejected_by_rules` instead |

Unstated quantities (`unknown_qty`) are recorded as notes, not approval reasons, for both kitchen and
agent orders. Stated quantities remain hard limits.

The check runs when the quote is prepared and inside shared order creation immediately before automatic
submission (including `place_order`), or again when a human approves. A person can change an agent's limits or revoke it in the Aimo UI at any time; the next
call sees the change. Every creation, change and revocation is written to the audit log (`agent_created`,
`agent_updated`, `agent_revoked`) with the person's name.

These are never negotiable, with or without approval: a requirement verdict other than `ok`, a product
that is not in the assortment, no price, no availability or a sales block, a quantity above the stated
availability, and a mock API that does not answer.

## Partial availability and substitution

Aimo never substitutes silently. What it does depends on how the order was specified.

**Explicit `items`.** Exactly these products are quoted. If the stated availability is lower than the
quantity, the quote is refused and nothing is replaced:

```json
{ "error": "rejected_by_rules",
  "message": "SamMills Pasta D'oro 5kg macaroni glutenfree pasta: only 19 available, order has 5000.",
  "blockers": [ "SamMills Pasta D'oro 5kg macaroni glutenfree pasta: only 19 available, order has 5000." ] }
```

**A `need` (also each entry of `needs`) without `product_id`.** Aimo sources it:

1. Search all name matches with structured size data in the requested unit (or pieces per sales unit).
   Check every requirement before restricting relevance; no dominant-category or first-30 shortcut.
2. Prefer whole name words with limited Finnish inflection tolerance. Different supplier categories mean
   different types, except two reviewed equivalences for explicit `jauhoseos` (21310/21320/21370) and `olut`
   (84966/85001/21405). A compound ending in the query word (`kevytmaitojuoma` for `maitojuoma`) also matches
   when all such compounds and all whole-word matches share one category. More than one type gives
   `selection_required`. Alcohol-free, decaffeinated and pre-cooked products that were not asked for are
   never allocated automatically; when most of the matching type consists of them (every beer in this
   snapshot), the need is `selection_required`. Whole words are not a head-noun guarantee (strawberry may
   be a flavour). A need with nothing orderable to choose from is `not_found`, with the reasons.
   Ambiguity is measured before removing unsafe matches; all displayed options must still be `ok`.
   `excluded_by_rules` counts failed/unknown relevant matches and gives up to three reasons.
3. Fetch offers for all verified relevant candidates, drop those without a price or a purchasable lot,
   and rank by **total cost to cover the amount in whole sales units and allowed lots**. Ties prefer a
   smaller pack, then historical reliability. Option notes show the covering cost and rounded amount.
4. For unambiguous needs, allocate from the cheapest covering option, cap by stated availability and
   rerank for the remaining amount, across at most three products. Each line carries `why`. This is a
   greedy allocation, not a globally optimal mixed-pack basket. Ambiguous needs allocate nothing.
5. Report `fulfilment`: `requested`, `covered`, `shortfall`, `split_across_products`. If the need cannot
   be covered in full, the quote is still issued for the covered part and `shortfall` is greater than 0.
   The agent decides whether a partial order is acceptable.

**Named options, not a change to automatic allocation.** For an unambiguous need, `ranked_options`
contains up to three distinct products, in role order `cheapest`, `most_reliable`, `most_sustainable`.
`roles` is an array of `{ role, label }`: one product can win several roles and appears once. Only verified,
orderable products compete. Reliability needs historical data; no history means no reliability role.
The automatic allocation still uses the complete price-ranked candidate set, not this shortlist.
Ambiguous needs retain up to five verified choices without role endorsements.

Each option's `basis` contains `cost_to_cover_eur_excl_vat`, rounded `sales_units`, `covered_amount`,
`delivery_reliability_history` (0–1 or null), packaging-label ids, `country_of_origin`, and
`co2_kg_per_kg_category_average` (or null). `note` shows the covering price, rounded amount and any stock
shortfall: a covering price is hypothetical if availability is insufficient. Label names and origin are
also returned on the option. Select another winner using `need.product_id` or explicit `items`.

**Sustainability rule.** A known environmental/responsibility packaging label is required: EU organic,
Nordic Swan, Rainforest Alliance, EU Ecolabel, MSC, Fairtrade, ASC, KRAV, Finnish organic Sun,
Soil Association, UTZ or Dolphin Safe. Multiple labels give no extra points. Among labelled candidates,
prefer declared Finnish origin as an explicit local-sourcing preference, not a transport-emissions claim.
Among the remaining candidates, use lower category-average CO₂ only when they all share one supplier
category and all have a CO₂ value. Otherwise ignore CO₂ for ranking. Remaining ties use the existing
covering-cost order. The winner carries this rule in `basis.sustainability_rule` in the requested language.
Heart Symbol, Food from Finland, Key Flag and unrecognised marks stay visible, but are not environmental
credentials. Missing data earns no invented evidence; unlabelled products are not claimed to be worse.
CO₂ is per kg, never a measured SKU footprint or an estimated total for a litre-based request. This
comparison is not an LCA, and Aimo does not verify certificates. It does not estimate waste and can
prefer a larger pack with more excess; the rounded amount and cost remain explicit.

**Declared substitutions and approval.** Set `substitute_for` on an item or need when it replaces another
product. The source id must exist and differ from the selected product, otherwise `invalid_request`.
A merged product line may not name conflicting source ids. All allergen, lot, stock and price checks still
apply. A new replacement carries `substitution: true`; `prepare_order` reports the approval reason,
`place_order` returns `approval_required`, and `request_approval` sends it to a person. The account has
already accepted a product if it is in its existing approved `overrides`/`swaps`, or in any previously
submitted order. Thus, after a human approves and submits, a new quote for that product needs no repeat
substitution approval (other limits still apply). This is product-level acceptance, not pair-specific
acceptance, and is isolated per account. No new memory is stored. The flag is fixed for the quote;
prepare a fresh quote after acceptance to use the updated account history.

Quote/order lines carry `substitute_for` and `substitution`; the order view also has `substitution_note`.
The kitchen order card says which product is replaced. Metadata survives price-change re-approval.
The signed-document schema is unchanged; substitution display fields are not new signed line claims.
In the kitchen UI, `resolveIssue` / `swapLine` already require a human click and remember it: the rule
is enforced structurally. A recipe's own special-diet product is not a substitution. Aimo never silently
substitutes; an agent that omits `substitute_for` merely orders that product within its authority, and
this rule cannot detect the undeclared substitution. Splitting an unpinned need is not itself a substitution.

**A `need` with `product_id`.** Only that product is used. A shortfall is reported, not filled.
`substitute_options` lists up to three verified replacements for the shortfall, supplier-declared pairs
first, then same-category matches, then other verified query matches, with covering cost within each tier.
Each has `tier` (`supplier_substitute`, `same_category`, `other_verified`), localized `tier_label`,
`basis.sales_units` and `substitute_for` (the pinned id) for a new explicit request. Each must cover the
shortfall on its own; these are not mixed-product allocations. They appear on `fulfilment_by_need`, and at
the top level for one need. Even `no_suitable_product` retains them under `fulfilment_by_need` when the
pinned product cannot supply anything. They never enter the quote automatically. Supplier pairs are not
a guarantee of recipe/flavour equivalence. Real
example, 300 kg of a product with 77 sacks of 3 kg available:

```json
"fulfilment": { "requested": 300, "covered": 231, "shortfall": 69, "unit": "kg", "split_across_products": 1 },
"lines": [ { "product_id": "473319", "quantity": 77, "why": "Cheapest product meeting the requirements (€4.19/kg), availability does not cover the full amount.", "…": "…" } ]
```

**Nothing suitable.** When no verified, orderable product exists:

```json
{
  "error": "no_suitable_product",
  "message": "No orderable product verified for the requirements was found.",
  "excluded": {
    "failed": 8,
    "unknown": 0,
    "examples": [
      { "name": "Valio Eila® 3 % milk drink 1 l lactose free", "reason": "Not suitable: milk-free. Supplier declares: contains milk." },
      { "name": "Valio Eila® skimmed milk drink 1,75 l lactose free", "reason": "Not suitable: milk-free. Supplier declares: contains milk." },
      { "name": "Arla Milkdrink 1L lactose free fat free UHT Suomesta", "reason": "Not suitable: milk-free. Supplier declares: contains milk." }
    ]
  }
}
```

A product whose supplier states no quantity (`unknown_qty`) is allocated the full remaining amount, and
the uncertainty is recorded as a note. It does not by itself force human approval.

## Error codes

Tool errors arrive as `isError: true` with `{ "error": "<code>", "message": "…" }`.

| Code | Returned by | Meaning | What to do |
| --- | --- | --- | --- |
| `approval_required` | `place_order` | The order is outside the agent's authority. `reasons[]` explains why | Call `request_approval` with the same quote |
| `price_changed` | `place_order` | A live price differs from the quote. `changes[]` lists them | Call `prepare_order` again |
| `rejected_by_rules` | `prepare_order`, `place_order`, `request_approval` | A rule refused the request: a requirement verdict of `fail` or `unknown`, product not in the assortment, quantity not a positive integer or not a multiple of `order_multiple`, no price, not available, quantity above availability, mock API unreachable, quote unknown or expired. `prepare_order` adds `blockers[]` | Read `message`. Change the product or quantity, or retry later if the supplier API was unreachable |
| `quote_already_used` | `place_order`, `request_approval` | The quote already produced an order. `order_id` and `order_status` name it | Use `get_order_status`, or call `prepare_order` for a new quote |
| `supplier_rate_limited` | `prepare_order`, `place_order`, `request_approval` | The supplier API's call budget is used up. `retry_after_seconds` says how long. Nothing was created or sent | Wait that long, then repeat the call |
| `no_suitable_product` | `prepare_order` with `need` or `needs` | No lines could be allocated and no need requires selection. `excluded` and `fulfilment_by_need` show what was ruled out | Refine the query or escalate; never relax a buyer's dietary requirements without their decision |
| `selection_required` | `prepare_order` with `need` or `needs` | No lines could be allocated and at least one need is ambiguous. `fulfilment_by_need[].selection_reason` and verified `ranked_options` explain the choice. No quote is created | Ask the buyer, then use explicit `items`, `need.product_id` or a refined query |
| `invalid_request` | `prepare_order` | No items/needs, a missing or self-referential `substitute_for`, or conflicting source ids on one merged line | Fix the call |
| `unknown_product` | `check_allergens`, and per item in `get_price_availability` | No such product id | Use `search_products` |
| `unknown_order` | `get_order_status` | No such order id | Use `list_orders` |
| `internal_error` | any | Unexpected failure. Nothing was ordered | Retry, then report |
| Input validation (text) | any | Arguments do not match the tool schema. The message starts with `MCP error -32602` | Fix the arguments |

Transport errors are HTTP responses with a JSON-RPC error body:

| HTTP | JSON-RPC code | Meaning |
| --- | --- | --- |
| 401 | -32001 | Missing or wrong bearer token, or a registered agent's token that was revoked or has expired (the message says which) |
| 403 | -32001 | A registered agent asked for another account than the one its token is authorised for |
| 405 | -32000 | Method other than POST |
| 500 | -32603 | Internal error |

## Trust and provenance

Every answer says where its facts come from, so an agent can decide how far to rely on them.

| Field | Where | What it tells you |
| --- | --- | --- |
| `provenance` | `get_authority`, `search_products`, `get_price_availability`, `check_allergens`, `prepare_order` | Plain statement of the three sources: challenge catalog (synthetic), live mock API, local order simulation |
| `offer.source` | every offer | `valio_mock`: the Valio Aimo challenge mock API |
| `offer.observed_at` | every offer | When that price and availability were fetched. Search results may be up to 60 seconds old. `get_price_availability`, `prepare_order`, `place_order`, `request_approval` and human approval always fetch fresh data |
| `supplier_data_updated` | every product | When the supplier last updated the product data the verdicts are based on |
| `requirement_checks[].evidence` | products | The exact supplier facts behind each verdict, with `kind` (declaration, ingredient, claim, missing data) |
| `delivery_reliability_history` | products, `ranked_options` | Historical reliability from the challenge dataset. Not a delivery promise |
| `co2_kg_per_kg_category_average` | products | Category average, not a product measurement |
| `content_sha256` | quote | Fingerprint of the quoted content |
| `signed_quote`, `signed_confirmation` | quote, submitted order | The server's signature over the commitment. See the next section |
| `identity` | `get_authority`, signed quote | Whether the agent's name is registered (from its token) or self-declared |
| `integration` | every order | States that prices and availability are from the mock API and that submission is a local simulation |
| `approval`, `recheck`, `events` | orders | Who decided, when, and what the last fresh re-check found |
| `hash` | audit entries | Position in the tamper-evident chain |

Allergen verdicts are computed by deterministic rules from supplier-declared allergens, the supplier
ingredient list and regulated claims. No language model takes part in a verdict.

## Signed quotes and order confirmations

An agent should not have to take a price or a confirmation on trust, and a person should not have to check
it by hand. The server therefore signs both with its own key, using open standards only:

| | |
| --- | --- |
| Format | JWS compact serialization, [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515): `base64url(header).base64url(payload).base64url(signature)`. The payload is a JSON claim set with the registered JWT claim names of [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) (`iss`, `sub`, `iat`, `exp`, `jti`) |
| Algorithm | `EdDSA` with Ed25519, [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037) |
| Header | `{ "alg": "EdDSA", "typ": "JWT", "kid": "<key id>" }` |
| Public key | JWK Set, [RFC 7517](https://www.rfc-editor.org/rfc/rfc7517), at `GET <base URL>/.well-known/jwks.json` (no authentication, `application/jwk-set+json`). One key: `{ "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…", "use": "sig", "alg": "EdDSA" }` |
| Key id | The JWK thumbprint of the key, [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638) |
| Server key | From `SIGNING_KEY`, otherwise generated on first start and kept in the data directory as `signing-key.pem` (file mode 600). It survives restarts; there is no rotation yet |

**Signed quote** (`prepare_order.signed_quote`), payload:

```json
{
  "iss": "https://<your-aimo-host>",
  "type": "aimo.quote.v1",
  "jti": "Q-42E0DBB0B0",
  "sub": "hotel-chain-agent",
  "iat": 1794682931,
  "exp": 1794683831,
  "agent": { "id": "ag-3f9a1c2e", "name": "hotel-chain-agent", "identity": "registered" },
  "account": "hotel",
  "delivery_date": "2026-11-16",
  "currency": "EUR",
  "lines": [ { "product_id": "464179", "gtin": "6413300017656", "quantity": 4, "unit_price_excl_vat": 2 } ],
  "total_excl_vat": 8,
  "vat": 1.08,
  "total_incl_vat": 9.08,
  "price_and_availability": { "source": "valio_mock", "fetched_at": "2026-11-14T19:02:11.143Z" },
  "single_use": true,
  "content_sha256": "…"
}
```

| Claim | Meaning |
| --- | --- |
| `iss` | The issuer: this server's public base URL |
| `type` | `aimo.quote.v1` or `aimo.order_confirmation.v1`. Check it, so one document cannot be passed off as the other |
| `jti` | The quote id (the order id on a confirmation) |
| `sub`, `agent` | Who the quote was given to. `agent.id` is `null` and `identity` is `self_declared` for the shared demo token; kitchen quotes use `id: "kitchen"`, `name: "Aimo"`, `identity: "kitchen"` |
| `account` | The customer account |
| `iat`, `exp` | Issued at, and the quote's expiry (`expires_at`), in seconds since the epoch |
| `lines` | Product id, GTIN, quantity in sales units and the fixed unit price excl. VAT |
| `price_and_availability.fetched_at` | When price and availability of these lines were fetched from the mock (the oldest, if they differ) |
| `content_sha256` | The same fingerprint as in the plain answer |

**Signed order confirmation** (`order.signed_confirmation` in `place_order`, `request_approval` and
`get_order_status`, once the order is `submitted`; `null` before that), payload:

```json
{
  "iss": "https://<your-aimo-host>",
  "type": "aimo.order_confirmation.v1",
  "jti": "AIMO-2026-0001",
  "iat": 1794682932,
  "order_id": "AIMO-2026-0001",
  "confirmation": "SIM-3738D6C5",
  "quote_id": "Q-42E0DBB0B0",
  "account": "hotel",
  "created_by": "Registered agent (hotel-chain-agent)",
  "agent_id": "ag-3f9a1c2e",
  "delivery_date": "2026-11-16",
  "currency": "EUR",
  "lines": [ { "product_id": "464179", "gtin": "6413300017656", "quantity": 4, "unit_price_excl_vat": 2 } ],
  "total_excl_vat": 8,
  "vat": 1.08,
  "total_incl_vat": 9.08,
  "approval_required": false,
  "approved_by": "Aimo rules",
  "approved_at": "2026-11-14T19:02:12.004Z",
  "submission": "local_simulation",
  "simulated": true
}
```

`approved_by` is `Aimo rules` when the order was inside the agent's authority, otherwise the person who
approved it. `submission` and `simulated` say, inside the signature, that nothing was sent to a supplier.

**How to verify**

1. Fetch the JWK Set from the server you connected to: `<origin of your MCP URL>/.well-known/jwks.json`.
   Use the address you configured, over HTTPS, not an address taken from an answer.
2. Split the JWS at the two dots. Decode the header. Require `alg` to be `EdDSA` and take the key whose
   `kid` matches.
3. Verify the signature over the ASCII bytes of `<header>.<payload>` (the first two parts as received).
4. Decode the payload and compare it with the plain answer: `type`, `jti`, lines, totals, and for a quote
   that `exp` has not passed.

With Node.js and no dependency:

```js
import { createPublicKey, verify } from 'node:crypto';

const { keys } = await (await fetch('https://<your-aimo-host>/.well-known/jwks.json')).json();
const [h, p, sig] = signedQuote.split('.');
const header = JSON.parse(Buffer.from(h, 'base64url'));
const jwk = keys.find(k => k.kid === header.kid);
const ok = header.alg === 'EdDSA' && !!jwk
  && verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
const claims = JSON.parse(Buffer.from(p, 'base64url'));
```

Any JOSE library does the same. `server/scripts/external-agent.ts` verifies every quote and confirmation
this way and prints the result.

**What a valid signature proves, and what it does not**

- It proves that this Aimo server issued exactly this content, for this agent and account, and that nobody
  changed it afterwards. The agent can keep the document as evidence of the price it was promised and of
  the confirmation it received, and anyone with the public key can check it later.
- It does not prove that the price and availability are right. They come from the Valio Aimo challenge mock
  API, which does not sign its answers; the signature covers what Aimo read and committed to, and when
  (`price_and_availability.fetched_at`). A wholesaler-signed offer would have to come from the wholesaler.
- It does not prove that an order reached a supplier. Submission is a local simulation, and the signed
  confirmation says so.
- It is only as good as the way the key was obtained. Fetch the JWK Set over HTTPS from the host you trust.
  The key is not certified by a third party, and there is no key rotation or revocation list yet.

## Human approvers

Who may approve is set on the server with `APPROVERS` (names and PINs).

- **Not set (default): open demo mode.** Anyone who can open the Aimo UI can approve, and the log records
  "Kitchen manager". `GET /api/state` says so in `integration.access` (`open: true`), and the UI shows it.
- **Set.** Approving, rejecting and cancelling an order, registering, changing and revoking an agent,
  changing the credit limit and resetting the demo need a signed-in approver: `POST /api/login` with
  `{ "name": "…", "pin": "…" }` returns a session token, sent as `Authorization: Bearer <token>` with
  `POST /api/action`. Without it those actions return HTTP 401 with `code: "approver_required"`. The
  approver's name is written to the audit log and to the order (`approval.decidedBy`, `events`, and
  `approved_by` in the signed confirmation). Reading the menu, portions, the draft and preparing an order
  stay open; an order nobody signed in for always waits for an approver, also when it is inside the kitchen
  user's own limit.
- PINs are not stored or logged: the server keeps only their SHA-256 in memory and compares in constant
  time. Five wrong PINs for a name lock that name for 15 minutes (HTTP 429 with `Retry-After`). Sessions
  last 30 minutes, live in memory only and end at a restart or with `POST /api/logout`.

Agents cannot sign in as approvers through MCP, and no MCP tool approves anything.

## Audit log and hash chain

Every action that matters is appended to one log with its actor: the kitchen manager or the signed-in
approver by name, Aimo, Aimo rules, `Registered agent (<name>)`, or `External agent (<name>)` for the shared
demo token. Actions an agent will see include `agent_created`, `agent_updated`, `agent_revoked`, `quote_prepared`, `quote_access_denied`, `quote_price_changed`, `agent_blocked`, `quote_reuse_blocked`,
`order_created`, `auto_approved`, `approval_required`, `duplicate_prevented`, `recheck_blocked`,
`order_approved`, `order_submitted`, `order_rejected` and `order_cancelled`.

Each entry stores

```
hash = SHA-256( previous_hash + JSON(entry) )
```

where `entry` is `{ id, at, actor, action, text, orderId }` with `actor` and `text` in all three
languages, and the first entry uses the literal `genesis` as previous hash. Changing or removing an
earlier entry breaks every later hash.

What this gives today, and what it does not:

- The chain is tamper-evident for whoever holds the state file. It is not anchored outside the
  application.
- The API returns each hash truncated to 16 hex characters and the text in one language, so an agent can
  reference entries but cannot recompute the chain from API output alone.
- The log keeps the latest 600 entries, and resetting the demo starts a new chain.

## Known limitations

- **The shared demo token is still accepted.** Its users share one credential, pick any account and declare
  their own name. It is marked `self_declared` everywhere, but it is not switched off; a production setup
  would remove it and use registered agents only (and OAuth 2.1 as in the MCP authorization specification).
- **Agent tokens are bearer tokens.** Whoever holds one can use it until it expires or is revoked. They are
  not bound to a client key or an IP address, and an agent's requests are not signed.
- **The agent's weekly limit is a rolling 7 days** over the orders it placed on its own authority. Orders a
  person approved do not count against it.
- **Signatures cover Aimo's commitment, not the supplier's data.** The Valio Aimo mock does not sign its
  answers. There is one signing key, without rotation, revocation or third-party certification.
- **Approvers are a name and a PIN from server configuration**, not accounts with roles. Sessions are kept
  in memory. Without `APPROVERS` the UI is open.
- **Retry after a rejection.** If a human rejected or cancelled the order, its quote stays used:
  `request_approval` returns `quote_already_used`, and `place_order` with the same key returns the old order
  with `duplicate: true`. Prepare a new quote and use a new key.
- **Fractional lot sizes** are read cautiously (see [Order quantities and lot sizes](#order-quantities-and-lot-sizes));
  this is our assumption, not a confirmed supplier rule.
- **The 429 behaviour is not verified against the live mock.** Pacing and cooldown follow Valio Aimo's
  description; whether the mock sends `Retry-After` is unknown, so 30 s is assumed without it.
- **Need matching is conservative, not semantic understanding.** Whole words plus catalog categories and
  a small set of material-variant markers decide ambiguity. Broad queries may require a choice even when
  a buyer considers the alternatives equivalent; same-category flavours and catalog errors can still
  escape detection. No dominant category is selected before allergen checks. Prefer explicit `items` or
  `need.product_id` when the intended product is known.
- **Substitution intent is declared by the agent.** `substitute_for` activates the rule; an undeclared
  product change cannot be detected. Acceptance is per product and account, not per source/replacement pair.
  Splits across products are reported in `fulfilment` and `why`, not treated as substitutions.
- **"Spent this week"** is the sum of all submitted orders in the kitchen's state, not a calendar-week
  window.
- **No notifications.** Poll `get_order_status`. There is no agent tool to cancel an order.
- **No rate limit on `/mcp`** in the demo. Offers for search are cached for 60 seconds; please do not loop
  over `get_price_availability`: every call spends the shared supplier call budget.
- **Mock snapshot.** The challenge availability data is fixed. Some cutoffs in it are already in the past,
  which by default forces human approval rather than refusing the order.
- **Submission is simulated.** A `submitted` order has a `SIM-…` confirmation and has not reached any
  supplier.
