// The outbound gateway for briefings: posts JSON to a webhook. It accepts no idempotency key, so an
// attempt whose response is lost can't be safely retried; the runtime reports it as in doubt.
import { type EffectAdapter, EffectNotDelivered, EffectRejected } from "actors-toolkit/runtime";

export interface BriefingRequest {
  itemId: string;
  title: string;
  summary: string;
}

export function webhookGateway(env: { BRIEFING_WEBHOOK_URL?: string }): EffectAdapter<BriefingRequest, { status: number }> {
  return {
    async run(briefing, { signal }) {
      if (!env.BRIEFING_WEBHOOK_URL) throw new EffectNotDelivered("no BRIEFING_WEBHOOK_URL is configured");
      // fetch may fail after the request left: that's ambiguous, so let it propagate (in doubt).
      const res = await fetch(env.BRIEFING_WEBHOOK_URL, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(briefing),
      });
      if (res.status >= 400 && res.status < 500) throw new EffectRejected(`gateway refused the briefing: HTTP ${res.status}`);
      if (!res.ok) throw new Error(`gateway answered HTTP ${res.status}; it may or may not have delivered`);
      return { status: res.status };
    },
  };
}
