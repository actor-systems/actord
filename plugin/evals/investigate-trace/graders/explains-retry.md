---
type: llm
---

PASS if the answer says that the first delivery of the release.observed message for crash-after-3.0.0 failed (an injected fault at or after the ledger's handler), that it was retried and then handled, and that the significant release was then notified once, citing message ids, sequence numbers, or event kinds from the log.
FAIL if it omits the failure or the retry, invents events that are not in the log, or says the release was notified more than once.
