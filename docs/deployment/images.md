# Published container images

Images are published to the GitHub Container Registry:

```
ghcr.io/andrewgoldfinch/mud-web-proxy
```

`linux/amd64` and `linux/arm64` are built from the same source and published
under a single manifest list, so the same reference works on an x86 VPS, an
Ampere instance, or a Raspberry Pi.

## Tag policy

| Tag                   | Moves?               | Use it for                  |
| --------------------- | -------------------- | --------------------------- |
| `4.0.0`, `4.0.0-rc.1` | never                | pinning to an exact release |
| `4.0`                 | stable patches only  | tracking a minor series     |
| `4`                   | stable minors only   | tracking a major series     |
| `latest`              | stable releases only | trying it out               |
| `sha256:...`          | never                | production                  |

**Release candidates never move `latest`, `4`, or `4.0`.** An RC that moved
`latest` would be deployed by someone who never intended to run it, so the
publish workflow opts every moving tag in explicitly and only for a stable
version. A prerelease publishes exactly one tag: its own full version.

For production, pin by **digest**. Tags are a naming convenience; only a
digest names one specific image and cannot be repointed:

```
ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:<digest>
```

## One-time setup for maintainers

GHCR creates a **private** package on first publish, inheriting the
repository's visibility only for the linked repo — not for anonymous pulls.
After the first successful release, set the package to public once, under
the package's settings on GitHub, or every `docker pull` from outside the
org fails with `denied`.

Nothing in the workflow can do this: package visibility is an account-level
setting, not something the publishing token controls.

## Verifying an image

Two independent things are published with every image. Check both — they
answer different questions.

### 1. Provenance attestation — "did this repository build it?"

```bash
gh attestation verify \
  oci://ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0 \
  --owner AndrewGoldfinch
```

A passing result means the image was built by this repository's release
workflow, from the commit the attestation names, and has not been replaced
since. A failure means you are holding something else — do not run it.

This is why nothing publishes images by hand. A manually pushed image has
no attestation, so it cannot be verified, and tolerating unverifiable
images would defeat the point of verifying any of them.

### 2. SBOM — "what is inside it?"

```bash
docker buildx imagetools inspect \
  ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0 \
  --format '{{ json .SBOM }}'
```

### Confirming the architectures

```bash
docker buildx imagetools inspect ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0
```

The manifest list should name both `linux/amd64` and `linux/arm64`. Entries
with platform `unknown/unknown` are the attestation manifests, not missing
architectures.

## Pinning by digest

Resolve the digest for the version you intend to run:

```bash
docker buildx imagetools inspect \
  ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0 \
  --format '{{ .Manifest.Digest }}'
```

Verify it before pinning it, not after:

```bash
gh attestation verify \
  oci://ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:<digest> \
  --owner AndrewGoldfinch
```

Then run that exact image:

```bash
docker run --rm \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --publish 127.0.0.1:6200:6200 \
  --env BIND_HOST=0.0.0.0 \
  --env INBOUND_TLS_MODE=off \
  --env ALLOW_INSECURE_INBOUND_NO_TLS=true \
  --env TN_HOST=mud.example.com \
  --env TN_PORT=4000 \
  ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:<digest>
```

A digest reference still resolves per-platform through the manifest list, so
one pinned value works on both architectures.

### With the Compose stack

> Requires the Compose stack from MWP-100 — `compose.yaml` in the repository
> root. If your checkout does not contain it, that work has not landed yet
> and the commands in this subsection have nothing to load.

That stack reads `MWP_IMAGE` and skips building from source when it is set,
so pinning is one line in `.env`:

```
MWP_IMAGE=ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:<digest>
```

## Upgrading a pinned deployment

Pinning by digest makes upgrades deliberate: resolve the new digest, verify
it, then restart against it — `docker compose up -d` with the stack above,
or re-running the container otherwise. Rolling back is the same operation
with the previous digest, which is worth recording somewhere durable: a
digest you cannot remember is a rollback you cannot perform.
