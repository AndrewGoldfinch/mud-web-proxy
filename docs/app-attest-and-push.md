# App Attest and push notifications

If you are running this proxy as a general MUD proxy, you can stop reading.
Both features are off by default, and leaving them off is the right choice.

They exist for one iOS client. App Attest checks that a connecting client is a
genuine instance of a specific iOS app; APNS delivers background push to that
app. Neither one does anything useful for a browser client or a generic
deployment, and enabling them has privacy consequences that the rest of the
proxy doesn't.

## Off by default

App Attest is enabled only when you set _both_ identifiers:

```dotenv
APPATTEST_BUNDLE_ID=com.example.yourapp
APPATTEST_TEAM_ID=ABCDE12345
```

Setting one without the other is a startup error, not a half-enabled feature.
`REQUIRE_APP_AUTH=true` then makes a valid assertion mandatory on every
WebSocket upgrade.

When App Attest is disabled, the routes don't exist:

```
$ curl -o /dev/null -w '%{http_code}\n' localhost:6200/attest/challenge
404
```

The proxy doesn't return an error, because it never registers the routes at
all. There is no attestation surface to attack on a deployment that hasn't
opted in.

APNS is separate and equally off by default. It activates only when the whole
`APNS_*` set is configured.

## Experimental, and not independently reviewed

**Caution:** The Apple verification implementation in this project hasn't had
an independent cryptographic review. That statement is about this code, not
about App Attest as an Apple technology.

Don't rely on it as your only access control. If you enable it, pair it with
`AUTH_MODE=shared-secret` so that a flaw in the attestation path doesn't leave
the service open. [Security model and threat model](security.md) lists attacks
against this implementation as explicitly out of scope, and the
[Security policy](../SECURITY.md) says the same for severity ratings.

## What actually goes to Apple

This section is the part most worth getting right, because the two features
differ completely.

### App Attest sends Apple nothing

The proxy verifies attestation _locally_. It checks the attestation
certificate chain against Apple's root CA, which ships in the repository as the
`config/apple-app-attest-root-ca.pem` file. There is no callback to Apple, no
verification API request, and no network egress on the attestation path at all.

Enabling App Attest doesn't tell Apple that your server exists, or who connects
to it.

### APNS is the only Apple egress

Push notifications go to `api.push.apple.com`, or
`api.sandbox.push.apple.com` when `APNS_ENVIRONMENT=sandbox`. Each request
carries the device's push token and the notification payload.

That is a real data flow to a third party, and it is the reason this document
exists.

## What is stored, and for how long

| State                | Where                              | Cap    | Lifetime               |
| -------------------- | ---------------------------------- | ------ | ---------------------- |
| Challenge nonces     | Memory only, never written to disk | 10,000 | 60 seconds             |
| Attested key records | `attested-keys.json`               | 10,000 | 90 days since last use |
| APNS device tokens   | In session state, memory only      | None   | Until the session ends |

**Location of `attested-keys.json`:**

| Deployment | Path                                                 |
| ---------- | ---------------------------------------------------- |
| systemd    | `/var/lib/mud-web-proxy/attested-keys.json`          |
| Compose    | The state volume mounted at `/var/lib/mud-web-proxy` |

Set the path explicitly with `ATTESTED_KEYS_PATH`. The _directory_ must exist
and be writable by the service user before startup. Otherwise the proxy
refuses to start, rather than accepting registrations and losing them at the
first flush:

```
App Attest is enabled but its state directory is not writable: /var/lib/mud-web-proxy
```

Under Docker, mount a volume at the _directory_, never at the
`attested-keys.json` file inside it. Atomic persistence writes and renames a
sibling temporary file, which a file-level mount makes impossible.

The proxy writes nothing until a key actually registers. A proxy with App
Attest enabled and no clients leaves the state file absent.

## Privacy implications

The proxy holds two different kinds of data, and they carry different weight.

**Attested key identifiers** are device-derived, persist on your host for up to
90 days after last use, and identify a device to your deployment. You can't use them to
reach the device, or to look it up anywhere else.

**APNS device tokens are device identifiers.** Holding them means holding data
that correlates a device across sessions. Sending them tells Apple
which device is receiving a notification, and when. If you enable push, you are
processing device identifiers on behalf of your users and disclosing them to a
third party.

Whether that triggers obligations under GDPR, CCPA, or anything else depends on
your jurisdiction and your relationship with your users. This document is not
legal advice and doesn't attempt to be. Know that enabling push moves you from
"operating a proxy" to "processing device identifiers", and that is a different
conversation with whoever asks.

If you don't need push, don't enable it. That is the cleanest privacy posture
available, and it costs you nothing on a generic deployment.

## What you need to enable them

App Attest requires only your Apple Developer team identifier and the app's
bundle identifier. Both are non-secret.

APNS additionally requires an APNS authentication key from your Apple Developer
account—a `.p8` file—plus its key identifier and topic.

The key is a secret. Don't bake it into an image, and don't commit it. Supply
it by path, from a file that the service user can read and nobody else can:

```dotenv
APNS_KEY_PATH=/etc/mud-web-proxy/apns-key.p8
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=ABCDE12345
APNS_TOPIC=com.example.yourapp
APNS_ENVIRONMENT=production
```

Under Compose, mount it as a read-only file or use a secret. It must never
appear in `docker history`, in the repository, or in an unencrypted backup. For
the full variable set, see the [Configuration reference](configuration.md). For
how the proxy keeps secrets out of logs, see
[Security model and threat model](security.md).

## Disable and purge

Turning the features off doesn't delete what is already stored. Do both.

1. Disable the features. Remove the identifiers from your environment file:

   ```dotenv
   # APPATTEST_BUNDLE_ID=...
   # APPATTEST_TEAM_ID=...
   # REQUIRE_APP_AUTH=true
   ```

   If push was enabled, remove the `APNS_*` block too.

2. Restart the proxy, so that it re-reads the configuration. It reads every
   setting once, at startup.

3. Delete the stored state:

   ```bash
   # systemd
   sudo rm -f /var/lib/mud-web-proxy/attested-keys.json

   # Compose — remove the state volume entirely
   docker compose down
   docker volume rm <project>_mud-web-proxy-state
   ```

4. Confirm the result. The routes must be gone, and no state must remain:

   ```bash
   curl -o /dev/null -w '%{http_code}\n' https://your-domain/attest/challenge   # 404
   ls /var/lib/mud-web-proxy/                                                   # no attested-keys.json
   ```

A `404` means that the proxy never registered the routes on this start, which
is the same state as a deployment that never enabled the feature.

Nonces need no purging. They live only in memory and expire after 60 seconds
regardless.

If you are done with push, also revoke the APNS key in your Apple Developer
account. Deleting the local file stops this deployment from using it, and
revoking stops anyone who obtained a copy.
