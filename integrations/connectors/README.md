# Server connectors

`createSdkConnectors({ userId, approval, env })` in `sdk.ts` constructs the real SDK adapters; `createConnectors` in `index.ts` accepts ports for network-free tests. Root/server code supplies a stable application user ID. Do not derive user IDs from model text or use one ID across tenants. Construction performs no network requests; no OAuth, provisioning, send, schema discovery, or account lookup occurs automatically.

Pinned dependencies: `@composio/core@0.22.0`, `agentmail@0.5.35`. Composio requires Node >=22.22.3 and a compatible zod peer (>=3.25.76 <5). The parent workspace owns its runtime and consolidated dependency installation.

## Environment

| Server variable | Purpose |
| --- | --- |
| `COMPOSIO_API_KEY` | Composio project key; explicit SDK input prevents CLI credential fallback |
| `COMPOSIO_GMAIL_AUTH_CONFIG_ID` | Optional Gmail auth configuration |
| `COMPOSIO_CALENDAR_AUTH_CONFIG_ID` | Optional Google Calendar auth configuration |
| `COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID` | Optional selected private Gmail connection |
| `COMPOSIO_GOOGLECALENDAR_CONNECTED_ACCOUNT_ID` | Optional selected private calendar connection |
| `AGENTMAIL_API_KEY` | AgentMail API key; no implicit organization signup |
| `AGENTMAIL_INBOX_ID` | One agent-owned inbox for read/send |

Keys stay in the server environment. Do not serialize these options into the face or extension, place them in `VITE_*`, or log SDK exceptions. Connector exceptions expose only stable codes and an optional HTTP status.

## Capabilities

- `connectionStatus()` projects connection IDs/statuses; never raw auth state.
- `initiateConnection({ toolkit: 'gmail' | 'googlecalendar', callbackUrl })` explicitly starts a Composio session and Connect Link. Root must use its fixed application callback URL and persist the returned connection attempt. Verify callback connection ID against the stored attempt and signed-in user; callback query parameters alone do not establish ownership.
- `readMail({ query?, limit? })` lists then fetches Gmail messages from the selected account, returning bounded plain text and headers. HTML and attachments are omitted.
- `readCalendar({ timeMin, timeMax, calendarId?, limit? })` lists events within an explicit RFC3339 interval with time zones; defaults to the primary calendar.
- `readAgentInbox()`, `readAgentMail({ limit? })`, `readAgentReply({ messageId })` operate only on `AGENTMAIL_INBOX_ID`. Reply content prefers `extractedText` to quoted history.
- `prepareSend({ provider, to, subject, body })` returns an immutable `PreparedSend`. This does not persist or approve a draft. Root stores it in its approval ledger and displays its exact content/account for user review.
- `sendPrepared(prepared, { approvalId, idempotencyKey })` invokes the injected `approval.run` before dispatching. Plain text only, at most 50 recipients; malformed addresses and header injection fail before dispatch.
- `prepareAgentInbox({ displayName, clientId })` returns immutable `PreparedInbox`. `createAgentInbox(prepared, authorization)` uses the same ledger. Provisioning is bound to a SHA256 credential fingerprint, and the stable client ID is forwarded to AgentMail. The returned inbox ID must be persisted by root and configured on the next connector instance; there is no separate connector database.

All account queries include the stable user, toolkit, optional auth config, and private-account scope. An explicit connection ID must appear within that scoped query. Without one, exactly one active connection is required; ambiguity fails closed. Gmail dispatch rechecks the same selected connection so a changed/revoked selection cannot redirect an approved email.

## Approval and retry contract

`ApprovedExecutor.run(envelope, { approvalId, idempotencyKey }, dispatch)` must atomically verify exact content/account/user, consume/reserve the approval, invoke dispatch once, and persist the JSON provider receipt. Persisted replay returns the stored receipt. In-flight and uncertain outcomes must stay blocked for reconciliation. Provider acceptance followed by a timeout is an uncertain outcome, not permission to retry. The connectors contain no ledger, approval bypass, or retry queue.

Both SDK send paths have retries disabled. Composio uses its authenticated `tools.proxyExecute` API against a fixed allowlist of Google REST endpoints. This avoids dependence on changing Composio tool output schemas. SDK tracking/version checks and automatic file handling are disabled. AgentMail uses its actual inbox-scoped methods and `maxRetries: 0`, including provisioning.

## First connection

Create a Composio project key at [the Composio dashboard](https://dashboard.composio.dev/) and configure Gmail/Google Calendar managed OAuth for the desired scopes. Gmail reads/searches need `gmail.readonly`; sends need `gmail.send`. Calendar reads need `calendar.readonly`. If using existing auth configs, scope them narrowly rather than silently broadening consent.

Create and verify an AgentMail account at [the AgentMail console](https://console.agentmail.to/) and generate an API key. Set an existing agent inbox, or explicitly review and approve local inbox provisioning. Runtime needs `inbox_read`, `message_read`, and `message_send`; creating a new inbox also needs `inbox_create`. Programmatic signup is deliberately not automatic: it sends an OTP to the attached human, and repeating signup can rotate the API key. Unverified organizations cannot send to external recipients.

## Evidence and limits

14 mocked tests pass: account/inbox scoping; ambiguity and foreign selection; calendar projection; approval denial; replay delegation; header injection; error redaction; approved inbox creation; actual pinned SDK wire formats and no automatic retry on failure. TypeScript checks passed against the installed exact SDKs. SDK tests replace global fetch and reject every unexpected request; no account was connected, inbox created, provider email sent, or live provider called during verification. These checks ran under local Node 22.21.1; the supported >=22.22.3 runtime and live credentials require parent verification.

Commands after workspace dependencies are installed:

```sh
node --experimental-strip-types --test integrations/connectors/*.test.ts
npx tsc -p integrations/connectors/tsconfig.json
```

Read requests are one page (up to 100 messages/events); next page tokens are returned as metadata. Calendar writes, sending replies into an existing thread, attachments, HTML, webhook setup, background polling, and provider signup/credential rotation are outside this slice.

## Official API evidence (checked October 4, 2026)

- [Composio manual authentication](https://docs.composio.dev/docs/authentication/manually-authenticating)
- [Composio authenticated proxy and version behavior](https://docs.composio.dev/docs/tools-direct/executing-tools)
- [Composio pinned SDK source](https://github.com/ComposioHQ/composio/tree/next/ts/packages/core)
- [Gmail list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [Calendar event list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [AgentMail messages](https://docs.agentmail.to/messages), [AgentMail permissions](https://docs.agentmail.to/permissions), [AgentMail onboarding](https://docs.agentmail.to/agent-onboarding), [AgentMail SDK reference](https://github.com/agentmail-to/agentmail-node/blob/main/reference.md)
