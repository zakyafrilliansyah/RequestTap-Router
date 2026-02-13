# Agent Guide

This guide is for AI agent developers who want to use RequestTap Router to access pay-per-request APIs.

## Overview

RequestTap Router is an x402 API gateway. You register upstream APIs with prices, and agents pay USDC per request to call them. The gateway handles payment verification, access control, and receipts — your agent just needs a wallet.

**How it works:**

1. Agent calls a gateway endpoint
2. Gateway responds with HTTP `402 Payment Required` and a price
3. Agent's SDK automatically pays the USDC amount via x402
4. Gateway verifies payment and proxies the request to the upstream API
5. Agent receives the API response + a structured receipt

## Getting Started

### Install the SDK

```bash
npm install @requesttap/sdk @requesttap/shared
```

### Prerequisites

You need **Coinbase Developer Platform (CDP) credentials** to create wallets and make payments:

1. Go to [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/) and create a project
2. Create an API key with **Server Wallet > Accounts** enabled and **Ed25519** algorithm
3. Generate a **Wallet Secret** from the [Server Wallet dashboard](https://portal.cdp.coinbase.com/products/server-wallets) (select your project → Wallet Secret → **Generate**). Save it immediately — it is shown only once.
4. Set all three credentials in your environment:

```
CDP_API_KEY_ID=<your key id>
CDP_API_KEY_SECRET=<your key secret>
CDP_WALLET_SECRET=<base64-encoded PKCS8 EC P-256 key from step 3>
```

### Discover Routes

Check what APIs are available on a gateway:

```bash
# OpenAPI spec
curl http://localhost:4402/docs

# Health check
curl http://localhost:4402/health
```

### Make Your First Request

```typescript
import { RequestTapClient } from "@requesttap/sdk";

const client = new RequestTapClient({
  gatewayBaseUrl: "http://localhost:4402",
});

// Initialize CDP wallet (reads CDP_* env vars automatically)
await client.init();

console.log("Wallet:", client.getWalletAddress());

// Make a paid API call
const { status, data, receipt } = await client.request("GET", "/api/v1/quote");

console.log("Status:", status);
console.log("Data:", data);
console.log("Outcome:", receipt?.outcome);   // SUCCESS, DENIED, or ERROR
console.log("Cost:", receipt?.price_usdc, "USDC");
```

## Payment Flow

The SDK handles the x402 payment flow automatically:

```
Agent SDK                    Gateway                     Upstream API
    │                           │                            │
    ├── GET /api/v1/quote ─────>│                            │
    │                           │                            │
    │<── 402 Payment Required ──│                            │
    │    (price: 0.01 USDC)     │                            │
    │                           │                            │
    ├── GET /api/v1/quote ─────>│                            │
    │    + x-payment header     │── proxy ──────────────────>│
    │                           │<── response ───────────────│
    │<── 200 OK + receipt ──────│                            │
```

The `init()` method sets up a CDP wallet and wraps `fetch` so that 402 responses are automatically paid and retried. You don't need to handle payments manually.

## AP2 Mandates

Mandates let agent owners set spending limits and access controls. A mandate is a signed JSON object that the agent attaches to requests.

### Mandate Fields

| Field | Description |
|-------|-------------|
| `mandate_id` | Unique identifier |
| `owner_pubkey` | Ethereum address of the mandate signer |
| `expires_at` | ISO 8601 expiration timestamp |
| `max_spend_usdc_per_day` | Daily spending cap in USDC |
| `allowlisted_tool_ids` | Array of tool IDs the agent can access |
| `require_user_confirm_for_price_over` | Optional — require confirmation above this price |
| `signature` | EIP-191 signature over the mandate fields |

### Using a Mandate

```typescript
import { RequestTapClient } from "@requesttap/sdk";
import type { Mandate } from "@requesttap/shared";

const mandate: Mandate = {
  mandate_id: "my-mandate-001",
  owner_pubkey: "0xYourEthereumAddress",
  expires_at: new Date(Date.now() + 86400000).toISOString(), // 24h
  max_spend_usdc_per_day: "1.00",
  allowlisted_tool_ids: ["quote", "search"],
  signature: "0x...", // EIP-191 signature
};

const client = new RequestTapClient({
  gatewayBaseUrl: "http://localhost:4402",
  mandate,
});

await client.init();

// This succeeds — "quote" is in the allowlist
const res1 = await client.request("GET", "/api/v1/quote");

// This is denied — "analysis" is not in the allowlist
const res2 = await client.request("POST", "/api/v1/analysis");
console.log(res2.receipt?.reason_code); // ENDPOINT_NOT_ALLOWLISTED
```

### What the Gateway Checks

- **Expiry** — rejects if `expires_at` is in the past
- **Signature** — verifies EIP-191 personal signature against `owner_pubkey`
- **Spend cap** — tracks daily spend per `mandate_id`, rejects if over `max_spend_usdc_per_day`
- **Allowlist** — rejects if the route's `tool_id` is not in `allowlisted_tool_ids`

## SDK Reference

### `RequestTapClient`

#### Constructor

```typescript
new RequestTapClient({
  gatewayBaseUrl: string,   // Gateway URL (e.g. "http://localhost:4402")
  mandate?: Mandate,        // Optional AP2 mandate
})
```

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `init(cdpConfig?)` | `Promise<void>` | Initialize CDP wallet and x402 payment. Reads `CDP_*` env vars by default. |
| `getWalletAddress()` | `string \| null` | Returns the wallet address after init. |
| `request(method, path, options?)` | `Promise<{ status, data, receipt? }>` | Make a paid API request. |
| `getReceipts()` | `Receipt[]` | Get all receipts from this session. |
| `getTotalSpent()` | `number` | Sum of USDC spent on successful requests. |
| `dumpReceipts()` | `string` | JSON string of all receipts. |

#### Request Options

```typescript
{
  headers?: Record<string, string>,  // Additional headers
  body?: unknown,                     // JSON body (for POST/PUT/PATCH)
  idempotencyKey?: string,           // Custom idempotency key (auto-generated if omitted)
}
```

## Receipts

Every request returns a structured receipt. Key fields:

| Field | Description |
|-------|-------------|
| `outcome` | `SUCCESS`, `DENIED`, `ERROR`, or `REFUNDED` |
| `reason_code` | Why the request was denied/errored (see below) |
| `price_usdc` | Amount charged |
| `tool_id` | Which API tool was called |
| `payment_tx_hash` | On-chain transaction hash (if paid) |
| `mandate_verdict` | `APPROVED`, `DENIED`, or `SKIPPED` |
| `latency_ms` | Upstream response time |

### Reason Codes

| Code | Meaning |
|------|---------|
| `OK` | Request succeeded |
| `MANDATE_BUDGET_EXCEEDED` | Daily spend cap reached |
| `ENDPOINT_NOT_ALLOWLISTED` | Tool not in mandate allowlist |
| `MANDATE_EXPIRED` | Mandate has expired |
| `RATE_LIMITED` | Too many requests (100/min per IP) |
| `REPLAY_DETECTED` | Duplicate idempotency key |
| `INVALID_SIGNATURE` | Mandate signature verification failed |
| `INVALID_PAYMENT` | x402 payment verification failed |
| `ROUTE_NOT_FOUND` | No matching route |
| `AGENT_BLOCKED` | Agent address is blacklisted |
| `SSRF_BLOCKED` | Route target is a private IP |
| `X402_UPSTREAM_BLOCKED` | Upstream already speaks x402 |
| `MANDATE_CONFIRM_REQUIRED` | Price exceeds mandate confirmation threshold |

## Example

See [`examples/agent-demo/`](examples/agent-demo/) for a complete working example that:

1. Creates a mandate with a spend cap and tool allowlist
2. Initializes a CDP wallet
3. Makes a successful request (tool in allowlist)
4. Makes a denied request (tool not in allowlist)
5. Prints a spend summary and saves receipts to file
