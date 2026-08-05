# MWP-115 App Attest and Push Privacy Design

## Goal

Publish `docs/app-attest-and-push.md` so an operator can decide whether to
enable two MUDBasher-specific features, and understand what enabling them
costs in privacy terms. Link it from the README and the security model.

## The issue's data-flow premise is partly wrong, and the correction matters

The issue says "enabling them sends data to Apple". That is true of APNS and
**false of App Attest**, and the difference is the most privacy-relevant fact
in the document.

Verified: `src/app-attest.ts` contains no `fetch`, no `http.request`, and no
`https.request`. Attestation is verified **entirely locally**, against the
Apple root CA bundled at `config/apple-app-attest-root-ca.pem` (798 bytes).
Enabling App Attest sends Apple nothing.

`src/notification-manager.ts:73` is the only Apple egress in the codebase —
`api.push.apple.com` or `api.sandbox.push.apple.com`, for APNS.

Writing "sends data to Apple" over both features would overstate the exposure
of one and blur the one that matters. The document separates them.

## Behaviour verified by running it, not by reading

| Claim                                  | Observed                                                             |
| -------------------------------------- | -------------------------------------------------------------------- |
| Routes absent when disabled            | `/attest/challenge` → **404**; `/health` → 200                       |
| Routes present when enabled            | `/attest/challenge` → **200**, `{"nonce":"<64 hex>","expires":<ms>}` |
| Register rejects garbage               | `POST /attest/register` empty body → **400**                         |
| Nothing persists until a key registers | State directory empty during a run with no registration              |
| Unwritable state directory             | Startup **aborts**, naming the directory                             |

That last one is the error already documented in the operations guide, and it
fired here unprompted — the state _directory_ must exist and be writable, not
just the file path be well-formed.

## Retention, from source

| State            | Where                | Cap    | TTL                         |
| ---------------- | -------------------- | ------ | --------------------------- |
| Challenge nonces | Memory only          | 10,000 | 60 seconds                  |
| Attested keys    | `attested-keys.json` | 10,000 | 90 days since last activity |

Nonces never touch disk. Attested keys do, which is what makes purge a real
operation rather than a restart.

## Privacy framing

Two distinct things, and the document keeps them apart:

- **Attested key identifiers** are device-derived and persist on the host for
  up to 90 days. They are not push tokens and cannot be used to reach a device.
- **APNS push tokens are device identifiers.** Holding them means holding data
  that correlates a device across sessions, and sending them means telling
  Apple which device is receiving what. This is the part with data-protection
  consequences.

The document states obligations exist without pretending to give legal advice —
naming what the operator now holds is useful; telling them what GDPR requires
of them is not mine to do.

## Out of scope

- Any runtime, configuration, or test change.
- Legal advice.
- Changing the features' defaults. They are already off.

## Success criteria

- States both features are optional, off by default, and irrelevant to a
  generic MUD deployment.
- Experimental status and the absence of independent cryptographic review are
  in the body, not a footnote.
- Separates local attestation verification from APNS egress rather than
  conflating them.
- Enumerates what is stored, where, with what cap and TTL.
- States that push tokens are device identifiers.
- Disable-and-purge instructions, tested.
- Linked from the README and `docs/security.md`.
