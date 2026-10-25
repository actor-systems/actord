---
type: llm
---

PASS if the answer says that the first delivery of the release.observed message for crash-after-3.0.0 failed (an injected fault after the ledger's handler had written), that the failed attempt's writes were rolled back, that the message was retried and then handled, and that the significant release was then notified once, citing message ids or event kinds from the log.
FAIL if it omits the failure or the retry, invents events not in the log, or says the release was notified more than once.
