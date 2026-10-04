# Connector slice

Implement personal Gmail/calendar through Composio and one agent-owned AgentMail inbox. Only this directory is owned by this lane. No live provider calls, connection initiation, inbox creation, or send during development.

Acceptance: scoped accounts; allowlisted operations; bounded plain data; provider errors stripped of credentials; approval executor called before sends; retry/replay remains under the parent ledger; provider sends never automatically retried. Mocked tests precede implementation. Root wiring, local database, UI, secrets, and deployment belong to the parent.

Verify: node --experimental-strip-types --test integrations/connectors/connectors.test.ts; root TypeScript check after SDK installation.

Stop: tests and SDK typecheck pass, interface and limitations delivered to parent.
