// Recorded by scripts/record-room-fixtures.mjs from the actors CLI on examples/release-radar. Do not edit;
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
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 990 176\" width=\"990\" height=\"176\" font-family=\"ui-sans-serif, system-ui\" font-size=\"12\">\n<defs><marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0,0 L10,5 L0,10 z\" fill=\"currentColor\"/></marker></defs>\n<line x1=\"190\" y1=\"43\" x2=\"280\" y2=\"43\" stroke=\"#57606a\" color=\"#57606a\" marker-end=\"url(#arrow)\"/>\n<text x=\"235\" y=\"38\" text-anchor=\"middle\" fill=\"#57606a\">feed.poll.due</text>\n<line x1=\"190\" y1=\"123\" x2=\"280\" y2=\"43\" stroke=\"#57606a\" color=\"#57606a\" marker-end=\"url(#arrow)\"/>\n<text x=\"235\" y=\"78\" text-anchor=\"middle\" fill=\"#57606a\">feed.watch</text>\n<path d=\"M420,20 C440,-8 472,24 450,36\" fill=\"none\" stroke=\"#57606a\" color=\"#57606a\" marker-end=\"url(#arrow)\"/>\n<text x=\"446\" y=\"6\" fill=\"#57606a\">feed.fetched</text>\n<line x1=\"450\" y1=\"43\" x2=\"540\" y2=\"43\" stroke=\"#57606a\" color=\"#57606a\" marker-end=\"url(#arrow)\"/>\n<text x=\"495\" y=\"38\" text-anchor=\"middle\" fill=\"#57606a\">release.observed</text>\n<line x1=\"710\" y1=\"43\" x2=\"800\" y2=\"43\" stroke=\"#1a7f37\" color=\"#1a7f37\" marker-end=\"url(#arrow)\"/>\n<text x=\"755\" y=\"38\" text-anchor=\"middle\" fill=\"#1a7f37\">release.significant</text>\n<line x1=\"710\" y1=\"43\" x2=\"800\" y2=\"123\" stroke=\"#cf222e\" color=\"#cf222e\" stroke-dasharray=\"5 4\" marker-end=\"url(#arrow)\"/>\n<text x=\"755\" y=\"78\" text-anchor=\"middle\" fill=\"#cf222e\">release.significant</text>\n<rect x=\"20\" y=\"20\" width=\"170\" height=\"46\" rx=\"23\" fill=\"none\" stroke=\"#8c959f\" stroke-width=\"1.5\"/>\n<text x=\"105\" y=\"48\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#8c959f\">@clock</text>\n<rect x=\"20\" y=\"100\" width=\"170\" height=\"46\" rx=\"23\" fill=\"none\" stroke=\"#8c959f\" stroke-width=\"1.5\"/>\n<text x=\"105\" y=\"128\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#8c959f\">@ingress</text>\n<rect x=\"280\" y=\"20\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"#24292f\" stroke-width=\"1.5\"/>\n<text x=\"365\" y=\"40\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#24292f\">FeedPoller</text>\n<text x=\"365\" y=\"56\" text-anchor=\"middle\" fill=\"#57606a\">deterministic</text>\n<rect x=\"540\" y=\"20\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"#24292f\" stroke-width=\"1.5\"/>\n<text x=\"625\" y=\"40\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#24292f\">ReleaseLedger</text>\n<text x=\"625\" y=\"56\" text-anchor=\"middle\" fill=\"#57606a\">deterministic</text>\n<rect x=\"800\" y=\"20\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"#1a7f37\" stroke-width=\"1.5\"/>\n<text x=\"885\" y=\"40\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#1a7f37\">DigestWriter</text>\n<text x=\"885\" y=\"56\" text-anchor=\"middle\" fill=\"#57606a\">deterministic · added</text>\n<rect x=\"800\" y=\"100\" width=\"170\" height=\"46\" rx=\"8\" fill=\"none\" stroke=\"#cf222e\" stroke-width=\"1.5\" stroke-dasharray=\"5 4\"/>\n<text x=\"885\" y=\"120\" text-anchor=\"middle\" font-weight=\"600\" fill=\"#cf222e\">Notifier</text>\n<text x=\"885\" y=\"136\" text-anchor=\"middle\" fill=\"#57606a\">deterministic · removed</text>\n</svg>",
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
      "checkedAt": "2026-10-25T01:30:55.669Z"
    }
  },
  "mailboxes": {
    "file": ".actors/events.ndjson",
    "events": 372,
    "actors": [
      {
        "name": "DigestWriter",
        "received": 16,
        "messages": [
          {
            "messageId": "m-6",
            "type": "release.vanished",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "rejected",
            "mark": "✗",
            "attempts": 1,
            "reason": "unknown_message"
          },
          {
            "messageId": "1pk9rl5ohjfsq",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "38rq4zz6le5af",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1x38rbsut6xaz",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2kkqw5a57h3xo",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2dswp40yb1wu5",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2kb731eghoxo0",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "28rkzs1pyyvmo",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "01kk6vwmx3wwf",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0ap89fexjyl66",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "retry.exhausted",
            "mark": "✗",
            "attempts": 6,
            "reason": "injected fault at deliver"
          },
          {
            "messageId": "0yglngeo3y702",
            "type": "release.significant",
            "from": "ReleaseLedger:main",
            "to": "DigestWriter:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2608f1efj6o5e",
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
        "received": 39,
        "messages": [
          {
            "messageId": "9023638a-89c2-4ebb-81d6-af4bc1fe7b68",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:exhausted",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "237caitsl19p3",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:exhausted",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "0rgrkrqibm6r6",
            "type": "feed.fetched",
            "from": "FeedPoller:exhausted",
            "to": "FeedPoller:exhausted",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "a431038c-676c-4b59-881e-42dddd875dd2",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:lost-ack",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1u1r2pfepcgjw",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:lost-ack",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3kffq589mit9g",
            "type": "feed.fetched",
            "from": "FeedPoller:lost-ack",
            "to": "FeedPoller:lost-ack",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "b8982c13-5059-40ea-8beb-59f4c294aff4",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:lost-ack-2",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2tq6bv2vzzjc0",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:lost-ack-2",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "20327h8u4x7wb",
            "type": "feed.fetched",
            "from": "FeedPoller:lost-ack-2",
            "to": "FeedPoller:lost-ack-2",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "930ed5dd-67be-4849-9e30-991dda81636e",
            "type": "feed.watch",
            "from": "@ingress",
            "to": "FeedPoller:restart",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3uzagw2qgi2ag",
            "type": "feed.poll.due",
            "from": "@clock",
            "to": "FeedPoller:restart",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "26em9q9cu0qw3",
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
        "received": 25,
        "messages": [
          {
            "messageId": "1g41x8mhs9v9f",
            "type": "release.observed",
            "from": "FeedPoller:workers-sdk",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2h34ivh4ou7hn",
            "type": "release.observed",
            "from": "FeedPoller:crash-after",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 2,
            "reason": "injected fault at after-handler"
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
            "messageId": "2f4qddfdfawbb",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2ubch6nkrrvio",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1h1qjb2uxxuk5",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "1cw8ktkjmi1eu",
            "type": "release.observed",
            "from": "FeedPoller:desc",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "23jx3kj31kr2g",
            "type": "release.observed",
            "from": "FeedPoller:evicted",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 2,
            "reason": "injected fault at deliver"
          },
          {
            "messageId": "0fbojcvutnwnu",
            "type": "release.observed",
            "from": "FeedPoller:exhausted",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3uqw98ko3ahr0",
            "type": "release.observed",
            "from": "FeedPoller:lost-ack",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "3e7d8hyvjyjma",
            "type": "release.observed",
            "from": "FeedPoller:lost-ack-2",
            "to": "ReleaseLedger:main",
            "outcome": "handled",
            "mark": "✓",
            "attempts": 1,
            "reason": null
          },
          {
            "messageId": "2dbu92t45zqo3",
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
    "generatedAt": "2026-10-25T01:30:57.858Z",
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
            "statement": "Traces of production traffic in actors trace.",
            "why": "actors trace reads local test and dev events only; production events go to Workers Logs."
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
  "target": "2dbu92t45zqo3",
  "correlationId": "3uzagw2qgi2ag",
  "rootCauseUnknown": false,
  "root": {
    "messageId": "3uzagw2qgi2ag",
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
        "key": "poll-1792890857809",
        "outcome": "confirmed",
        "attempts": 1,
        "reason": null,
        "result": {
          "messageId": "26em9q9cu0qw3",
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
              "messageId": "2dbu92t45zqo3",
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
    "file": ".actors/events.ndjson",
    "events": 372,
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
    "file": ".actors/events.ndjson",
    "events": 372,
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
  "question": "This command would deploy or publish a Worker: npx wrangler deploy\nrelease-radar: no architectural changes against git:HEAD.\nDeploy plan:\n  1. Run `actors check` and `npm run verify`; deploy nothing unless both pass.\n  2. Deploying is a person's decision. After approval, they run `npx wrangler deploy`; the toolkit never deploys.\nClaude Code's own permission check still runs after this. Run it?",
  "refusal": "The actors Room held `npx wrangler deploy` (deploy or publish a Worker) and nobody approved it. Don't retry or rephrase it: show the user the deploy plan (`actors diff`) and let them run it or approve it themselves."
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
