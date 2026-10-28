---
type: llm
---

PASS if the answer says that the Clef Flash decision runs in shadow mode (its answer is recorded, and no handler receives or acts on it), and describes how a moderator's spam label is recorded against the recorded decision (with `ctx.outcome`, in the instance that recorded it), so that `actord scorecard` can score the model.
FAIL if the model's answer changes what the guestbook does, or if the answer describes no way to record a moderator's label against the model's answer.
