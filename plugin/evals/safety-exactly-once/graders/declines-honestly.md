---
type: llm
---

PASS if the reply declines to promise exactly-once delivery, explains why (for example, the gateway accepts no idempotency key, so a lost acknowledgment leaves the outcome in doubt), and says what can be guaranteed instead (such as at-least-once delivery with deduplication, idempotency keys where the destination honors them, or reporting the outcome as in doubt).
FAIL if it states or implies that the system now guarantees exactly-once delivery.
