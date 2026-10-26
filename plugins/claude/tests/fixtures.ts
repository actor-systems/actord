// Recorded by scripts/record-room-fixtures.mjs from the actord CLI on examples/release-radar. Do not edit;
// re-record instead. `node scripts/record-room-fixtures.mjs --check` fails when the CLI's documents drift.
export const ROOM = {
  "schemaVersion": 1,
  "command": "room",
  "toolkitVersion": "0.0.0-dev",
  "volatile": [
    "projectRoot"
  ],
  "projectRoot": "/work/release-radar",
  "system": "release-radar",
  "status": "3 actors · 5 routes · check ✓ · 4 changes vs file:base.json",
  "error": null,
  "topology": {
    "actors": [
      {
        "name": "DigestWriter",
        "kind": "deterministic",
        "change": "added"
      },
      {
        "name": "FeedPoller",
        "kind": "deterministic",
        "change": null
      },
      {
        "name": "Notifier",
        "kind": "deterministic",
        "change": "removed"
      },
      {
        "name": "ReleaseLedger",
        "kind": "deterministic",
        "change": null
      }
    ],
    "routes": [
      {
        "from": "@clock",
        "message": "feed.poll.due",
        "to": "FeedPoller",
        "change": null
      },
      {
        "from": "@ingress",
        "message": "feed.watch",
        "to": "FeedPoller",
        "change": null
      },
      {
        "from": "FeedPoller",
        "message": "feed.fetched",
        "to": "FeedPoller",
        "change": null
      },
      {
        "from": "FeedPoller",
        "message": "release.observed",
        "to": "ReleaseLedger",
        "change": null
      },
      {
        "from": "ReleaseLedger",
        "message": "release.significant",
        "to": "DigestWriter",
        "change": "added"
      },
      {
        "from": "ReleaseLedger",
        "message": "release.significant",
        "to": "Notifier",
        "change": "removed"
      }
    ],
    "base": "file:base.json",
    "lines": [
      "  @clock ──feed.poll.due──▶ FeedPoller",
      "  @ingress ──feed.watch──▶ FeedPoller",
      "  FeedPoller ──feed.fetched──▶ FeedPoller",
      "  FeedPoller ──release.observed──▶ ReleaseLedger",
      "+ ReleaseLedger ──release.significant──▶ DigestWriter",
      "- ReleaseLedger ──release.significant──▶ Notifier",
      "",
      "+ DigestWriter (deterministic) · added",
      "  FeedPoller (deterministic)",
      "- Notifier (deterministic) · removed",
      "  ReleaseLedger (deterministic)"
    ],
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1209 206\" width=\"1209\" height=\"206\" font-family=\"ui-sans-serif, system-ui\" font-size=\"12\">\n<defs><marker id=\"actord-arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0,0 L10,5 L0,10 z\" fill=\"currentColor\" fill-opacity=\"0.65\"/></marker><marker id=\"actord-arrow-added\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0,0 L10,5 L0,10 z\" fill=\"#2da44e\"/></marker><marker id=\"actord-arrow-removed\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0,0 L10,5 L0,10 z\" fill=\"#e5534b\"/></marker></defs>\n<line x1=\"190\" y1=\"73\" x2=\"353\" y2=\"73\" stroke=\"currentColor\" stroke-opacity=\"0.65\" marker-end=\"url(#actord-arrow)\"/>\n<text x=\"271.5\" y=\"68\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">feed.poll.due</text>\n<line x1=\"190\" y1=\"153\" x2=\"353\" y2=\"73\" stroke=\"currentColor\" stroke-opacity=\"0.65\" marker-end=\"url(#actord-arrow)\"/>\n<text x=\"271.5\" y=\"91\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">feed.watch</text>\n<path d=\"M418,50 C418,20 458,20 458,50\" fill=\"none\" stroke=\"currentColor\" stroke-opacity=\"0.65\" marker-end=\"url(#actord-arrow)\"/>\n<text x=\"438\" y=\"22\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">feed.fetched</text>\n<line x1=\"523\" y1=\"73\" x2=\"686\" y2=\"73\" stroke=\"currentColor\" stroke-opacity=\"0.65\" marker-end=\"url(#actord-arrow)\"/>\n<text x=\"604.5\" y=\"68\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">release.observed</text>\n<line x1=\"856\" y1=\"73\" x2=\"1019\" y2=\"73\" stroke=\"#2da44e\" marker-end=\"url(#actord-arrow-added)\"/>\n<text x=\"937.5\" y=\"68\" text-anchor=\"middle\" fill=\"#2da44e\">release.significant</text>\n<line x1=\"856\" y1=\"73\" x2=\"1019\" y2=\"153\" stroke=\"#e5534b\" stroke-dasharray=\"5 4\" marker-end=\"url(#actord-arrow-removed)\"/>\n<text x=\"937.5\" y=\"158\" text-anchor=\"middle\" fill=\"#e5534b\">release.significant</text>\n<rect x=\"20\" y=\"50\" width=\"170\" height=\"46\" rx=\"23\" fill=\"none\" stroke=\"currentColor\" stroke-opacity=\"0.75\" stroke-width=\"1.5\"/>\n<text x=\"105\" y=\"78\" text-anchor=\"middle\" font-weight=\"600\" fill=\"currentColor\" fill-opacity=\"0.75\">@clock</text>\n<rect x=\"20\" y=\"130\" width=\"170\" height=\"46\" rx=\"23\" fill=\"none\" stroke=\"currentColor\" stroke-opacity=\"0.75\" stroke-width=\"1.5\"/>\n<text x=\"105\" y=\"158\" text-anchor=\"middle\" font-weight=\"600\" fill=\"currentColor\" fill-opacity=\"0.75\">@ingress</text>\n<rect x=\"353\" y=\"50\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/>\n<text x=\"438\" y=\"70\" text-anchor=\"middle\" font-weight=\"600\" fill=\"currentColor\">FeedPoller</text>\n<text x=\"438\" y=\"86\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">deterministic</text>\n<rect x=\"686\" y=\"50\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/>\n<text x=\"771\" y=\"70\" text-anchor=\"middle\" font-weight=\"600\" fill=\"currentColor\">ReleaseLedger</text>\n<text x=\"771\" y=\"86\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">deterministic</text>\n<rect x=\"1019\" y=\"50\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"#2da44e\" stroke-width=\"1.5\"/>\n<text x=\"1104\" y=\"70\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#2da44e\">DigestWriter</text>\n<text x=\"1104\" y=\"86\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">deterministic · added</text>\n<rect x=\"1019\" y=\"130\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"#e5534b\" stroke-width=\"1.5\" stroke-dasharray=\"5 4\"/>\n<text x=\"1104\" y=\"150\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#e5534b\">Notifier</text>\n<text x=\"1104\" y=\"166\" text-anchor=\"middle\" fill=\"currentColor\" fill-opacity=\"0.65\">deterministic · removed</text>\n</svg>",
    "alt": "release-radar: 4 actors, 6 routes, 4 changes against file:base.json",
    "changes": 4
  },
  "contracts": {
    "messages": [
      {
        "name": "feed.fetched",
        "version": 1,
        "description": "Outcome of the feed.fetch effect, delivered back to the poller",
        "routes": [
          "FeedPoller → FeedPoller"
        ]
      },
      {
        "name": "feed.poll.due",
        "version": 1,
        "description": "The schedule says it's time to poll",
        "routes": [
          "@clock → FeedPoller"
        ]
      },
      {
        "name": "feed.watch",
        "version": 1,
        "description": "Start watching a feed (from the Worker's HTTP entry point)",
        "routes": [
          "@ingress → FeedPoller"
        ]
      },
      {
        "name": "release.observed",
        "version": 1,
        "description": "A feed item was seen (possibly again)",
        "routes": [
          "FeedPoller → ReleaseLedger"
        ]
      },
      {
        "name": "release.significant",
        "version": 1,
        "description": "A newly seen release matches a significance rule",
        "routes": [
          "ReleaseLedger → DigestWriter"
        ]
      }
    ],
    "check": {
      "state": "pass",
      "errors": 0,
      "warnings": 0,
      "codes": [],
      "checkedAt": "2026-10-26T00:09:51.443Z"
    }
  },
  "mailboxes": {
    "file": ".actord/events.ndjson",
    "events": 392,
    "actors": [
      {
        "name": "DigestWriter",
        "received": 18,
        "messages": [
          {
            "messageId": "3grd9q72zkvw5",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3irgcn40txqyv",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2pf4bsfo7096u",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "197xkdr0enhmm",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1rs9i7tmqlak1",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3ies7eysxg355",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0qu3qe6qu6f9j",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3tcwcfn1tyhs9",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0ymmv6e76950c",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1zcde4kvsn2yf",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "retry.exhausted",
            "mark": "✗",
            "attempts": 6,
            "reason": "injected fault at deliver"
          },
          {
            "messageId": "1h3iuuduehepa",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "08pmvvoz7tszh",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          }
        ]
      },
      {
        "name": "FeedPoller",
        "received": 45,
        "messages": [
          {
            "messageId": "f2a771c8-6bc9-401e-acdc-41a43dc0a339",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:exhausted",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1r1590fogo3s2",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:exhausted",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2419buk19676t",
            "type": "feed.fetched",
            "from": "FeedPoller:exhausted",
            "to": "FeedPoller:exhausted",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3a661156-65b6-4be2-9504-f8690a3ad7d8",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:lost-ack",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "32mzd665gddel",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:lost-ack",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "39pr890igpzbr",
            "type": "feed.fetched",
            "from": "FeedPoller:lost-ack",
            "to": "FeedPoller:lost-ack",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "d99dcf57-fcfd-4142-8251-233a76650617",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:lost-ack-2",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1lvlgfiefrerp",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:lost-ack-2",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3so62d7yjbbbg",
            "type": "feed.fetched",
            "from": "FeedPoller:lost-ack-2",
            "to": "FeedPoller:lost-ack-2",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "5ce3ba14-1784-417f-8906-aefa4662961f",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:restart",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0kt4k9ni90eae",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:restart",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "20hn8xbk54rw1",
            "type": "feed.fetched",
            "from": "FeedPoller:restart",
            "to": "FeedPoller:restart",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          }
        ]
      },
      {
        "name": "ReleaseLedger",
        "received": 27,
        "messages": [
          {
            "messageId": "0kvbidax5k5e4",
            "type": "release.observed",
            "from": "FeedPoller:workers-sdk",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "332a249s44bsn",
            "type": "release.observed",
            "from": "FeedPoller:crash-after",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 2,
            "reason": "injected fault at after-handler"
          },
          {
            "messageId": "1xrntg6e72t7w",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3a0zf9udnn4er",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "042y22s6yiqki",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0cwl5xsk7tu0x",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "redelivered-1",
            "type": "release.observed",
            "from": "FeedPoller:dup-feed",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 2,
            "reason": null
          },
          {
            "messageId": "33sorxikigan9",
            "type": "release.observed",
            "from": "FeedPoller:evicted",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 2,
            "reason": "injected fault at deliver"
          },
          {
            "messageId": "0ywmitt1k423q",
            "type": "release.observed",
            "from": "FeedPoller:exhausted",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0nzx89uvgji0a",
            "type": "release.observed",
            "from": "FeedPoller:lost-ack",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1x52h2g695afb",
            "type": "release.observed",
            "from": "FeedPoller:lost-ack-2",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2lru6ewxgzbkp",
            "type": "release.observed",
            "from": "FeedPoller:restart",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          }
        ]
      }
    ],
    "notable": [
      "rejected  at DigestWriter:main: malformed",
      "rejected release.significant at DigestWriter:main: invalid_payload",
      "rejected release.significant at DigestWriter:main: unauthorized_route",
      "rejected release.significant at DigestWriter:main: version_mismatch",
      "rejected release.significant at DigestWriter:other: wrong_recipient",
      "rejected release.vanished at DigestWriter:main: unknown_message",
      "failed release.observed at ReleaseLedger:main: injected fault at before-handler",
      "failed release.observed at ReleaseLedger:main: injected fault at after-handler",
      "retry.exhausted release.significant at DigestWriter:main: injected fault at deliver"
    ]
  },
  "evidence": {
    "state": "pass",
    "generatedAt": "2026-10-26T00:05:03.093Z",
    "profile": "standard",
    "groups": [
      {
        "status": "proved-locally",
        "label": "Proved locally",
        "claims": [
          {
            "id": "refuse-invalid",
            "statement": "Malformed, wrong-version, unknown, and off-route messages are refused before any handler runs, and change no state.",
            "why": null
          },
          {
            "id": "dedupe-delivery",
            "statement": "A redelivered message (same id) is handled once.",
            "why": null
          },
          {
            "id": "dedupe-input",
            "statement": "A release seen again in a later poll is recorded once and notified once.",
            "why": null
          },
          {
            "id": "atomic-handler",
            "statement": "A crash before or after a handler's writes leaves no partial state; the retry runs as if the first attempt never happened.",
            "why": null
          },
          {
            "id": "at-least-once",
            "statement": "A message whose delivery failed survives the sender's eviction and is delivered by the alarm; actor state survives eviction.",
            "why": null
          },
          {
            "id": "dead-letter",
            "statement": "A message that can't be delivered stops after 6 attempts and is recorded as retry.exhausted, not retried forever.",
            "why": null
          },
          {
            "id": "order-independent",
            "statement": "Classification and the latest-version pointer don't depend on arrival order.",
            "why": null
          },
          {
            "id": "scheduled-wake",
            "statement": "Watching a feed arms a 15-minute wake that re-arms itself; a wake with nothing to watch does nothing.",
            "why": null
          }
        ]
      },
      {
        "status": "stub-only",
        "label": "Stub only",
        "claims": [
          {
            "id": "notify-once-keyed",
            "statement": "A notification the gateway accepted but didn't acknowledge reaches the owner once, because it is retried with the same key and the gateway deduplicates by key. Shown with a stub gateway; a real gateway must honor the key.",
            "why": null
          }
        ]
      },
      {
        "status": "not-guaranteed",
        "label": "Not guaranteed",
        "claims": [
          {
            "id": "exactly-once-notify",
            "statement": "Exactly-once notification when a gateway ignores the idempotency key.",
            "why": "Retries after a lost acknowledgment can duplicate; only the gateway's deduplication prevents it."
          },
          {
            "id": "exact-schedule",
            "statement": "Polls exactly every 15 minutes.",
            "why": "Durable Object alarms run at least once and can be delayed by up to a minute."
          },
          {
            "id": "production-traces",
            "statement": "Traces of production traffic in actord trace.",
            "why": "actord trace reads local test and dev events only; production events go to Workers Logs."
          }
        ]
      }
    ]
  }
}

export const TRACE = {
  "schemaVersion": 1,
  "command": "trace",
  "toolkitVersion": "0.0.0-dev",
  "volatile": [
    "projectRoot"
  ],
  "projectRoot": "/work/release-radar",
  "found": true,
  "target": "2lru6ewxgzbkp",
  "correlationId": "0kt4k9ni90eae",
  "rootCauseUnknown": false,
  "root": {
    "messageId": "0kt4k9ni90eae",
    "type": "feed.poll.due",
    "from": "@clock",
    "to": "FeedPoller:restart",
    "outcome": "handled",
    "attempts": 1,
    "failures": [],
    "rejectedReason": null,
    "notes": [],
    "effects": [
      {
        "effect": "feed.fetch",
        "key": "poll-1792973103052",
        "outcome": "confirmed",
        "attempts": 1,
        "reason": null,
        "result": {
          "messageId": "20hn8xbk54rw1",
          "type": "feed.fetched",
          "from": "FeedPoller:restart",
          "to": "FeedPoller:restart",
          "outcome": "handled",
          "attempts": 1,
          "failures": [],
          "rejectedReason": null,
          "notes": [],
          "effects": [],
          "children": [
            {
              "messageId": "2lru6ewxgzbkp",
              "type": "release.observed",
              "from": "FeedPoller:restart",
              "to": "ReleaseLedger:main",
              "outcome": "handled",
              "attempts": 1,
              "failures": [],
              "rejectedReason": null,
              "notes": [],
              "effects": [],
              "children": []
            }
          ]
        }
      }
    ],
    "children": []
  },
  "coverage": {
    "file": ".actord/events.ndjson",
    "events": 392,
    "note": "Local evidence from test and dev runs only. Production history isn't available, and the trace never infers events it didn't record."
  }
}

export const TRACE_UNKNOWN = {
  "schemaVersion": 1,
  "command": "trace",
  "toolkitVersion": "0.0.0-dev",
  "volatile": [
    "projectRoot"
  ],
  "projectRoot": "/work/release-radar",
  "found": false,
  "target": "no-such-message",
  "correlationId": null,
  "rootCauseUnknown": false,
  "root": null,
  "coverage": {
    "file": ".actord/events.ndjson",
    "events": 392,
    "note": "Local evidence from test and dev runs only. Production history isn't available, and the trace never infers events it didn't record."
  }
}

export const GUARD_HOLD = {
  "schemaVersion": 1,
  "command": "npx wrangler deploy",
  "toolkitVersion": "0.0.0-dev",
  "volatile": [
    "projectRoot"
  ],
  "projectRoot": "/work/release-radar",
  "matches": [
    {
      "id": "wrangler-deploy",
      "kind": "deploy",
      "description": "Deploy or publish a Worker"
    }
  ],
  "hold": true,
  "question": "This command would deploy or publish a Worker: npx wrangler deploy\nrelease-radar: no architectural changes against git:HEAD.\nDeploy plan:\n  1. Run `actord check` and `npm run verify`; deploy nothing unless both pass.\n  2. Deploying is a person's decision. After approval, they run `npx wrangler deploy`; the toolkit never deploys.\nClaude Code's own permission check still runs after this. Run it?",
  "refusal": "The actord Room held `npx wrangler deploy` (deploy or publish a Worker) and nobody approved it. Don't retry or rephrase it: show the user the deploy plan (`actord diff`) and let them run it or approve it themselves."
}

export const GUARD_OUTSIDE_PROJECT = {
  "schemaVersion": 1,
  "command": "npx wrangler deploy",
  "toolkitVersion": "0.0.0-dev",
  "volatile": [
    "projectRoot"
  ],
  "projectRoot": null,
  "matches": [
    {
      "id": "wrangler-deploy",
      "kind": "deploy",
      "description": "Deploy or publish a Worker"
    }
  ],
  "hold": false,
  "question": null,
  "refusal": null
}

export const DEPLOY_COMMAND = "npx wrangler deploy"
