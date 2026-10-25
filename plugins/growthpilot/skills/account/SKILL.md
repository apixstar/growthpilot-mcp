---
name: account
description: Check APIxStar Grow connection, credits, subscription, plans or API key metadata, and guide explicitly requested billing or key changes through APIxStar Grow browser confirmation. Use for APIxStar Grow account requests, not general financial advice or website research.
---

# APIxStar Grow account

Use the connected account tools and respond in the user's language. Discover their actual names and schemas; clients may add a plugin prefix, and permissions or deployment settings may hide tools.

## Read or verify

| Request | Tool |
| --- | --- |
| Check the connection, remaining credits or subscription | `growthpilot_account_get` |
| Inspect available plans, upgrades or confirmed payments | `growthpilot_billing_get` |
| List API key names, IDs, scopes and expiry | `growthpilot_api_keys_list` |
| Resume an existing account request | `growthpilot_action_get` with its `action_id` |

Account reads do not consume query credits. For a connection check, invoke `growthpilot_account_get` through the actual MCP tool; an installed plugin or cached tool list alone does not prove authorization works. Do not submit a website query to test setup.

If the tools are missing, report that the current conversation has not loaded them. Reload through the client's supported controls or explain that a fresh conversation is needed. If authorization fails, use the client's native OAuth flow. Do not create a second MCP connection, invent a successful check or request credentials in chat.

Use returned allowances and subscription fields as the source of truth. Do not hardcode plan prices, free credits, renewal dates or currency. `growthpilot_billing_get` defaults to the account's current subscription market or `GLOBAL`; request `CN` only when appropriate to the user's request.

## Prepare an explicitly requested change

An account question or exhausted query quota does not authorize purchasing, upgrading, canceling or changing keys.

1. Resolve the requested operation and target from live account/plan/key metadata. Obtain any missing plan choice or key target; do not guess. For key creation, choose only the scopes needed for the user's stated purpose.
2. Use `growthpilot_billing_request` for `purchase`, `upgrade` or `cancel`, or `growthpilot_api_key_request` for `create`, `rotate` or `revoke`. Read the current schema and use a fresh `request_id` of 8–128 letters, digits, underscores or hyphens. For an uncertain retry, keep the same request ID and exact parameters.
3. Present the returned summary and `confirmation_url` so the user can confirm on APIxStar Grow. This browser confirmation is required by the service. Explain the concrete effect, including renewal, an upgrade quote, or immediate invalidation of an old key where applicable. Preparing a request has not completed the change.
4. Use `growthpilot_action_get` with the returned `action_id` to check progress after confirmation. Distinguish pending confirmation, processing, awaiting payment, success, expiry and failure. Do not claim a purchase succeeded while payment is pending; report completion only from a successful result.
5. Stop on rejection, expiry, insufficient permissions or failure and report the returned reason. Do not automatically create a fresh action after expiry or perform broader changes to recover.

API key secrets are only available in the browser console, never through these MCP tools. Do not ask the user to paste a secret into chat or try to retrieve one through another route. Revoking an APIxStar Grow OAuth connection also revokes its associated keys; it does not cancel the subscription. If the requested tool is unavailable, direct the user to the matching console page instead of pretending to execute it.
