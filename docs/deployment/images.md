# Published container images

The release workflow publishes images to the GitHub Container Registry:

```
ghcr.io/andrewgoldfinch/mud-web-proxy
```

The workflow builds `linux/amd64` and `linux/arm64` from the same source and
publishes them under a single manifest list, so the same reference works on an x86 VPS, an
Ampere instance, or a Raspberry Pi.

## Tag policy

| Tag                   | When it moves        | Use it for                  |
| --------------------- | -------------------- | --------------------------- |
| `4.0.0`, `4.0.0-rc.1` | Never                | Pinning to an exact release |
| `4.0`                 | Stable patches only  | Tracking a minor series     |
| `4`                   | Stable minors only   | Tracking a major series     |
| `latest`              | Stable releases only | Trying the proxy out        |
| `sha256:...`          | Never                | Production                  |

**Release candidates never move `latest`, `4`, or `4.0`.** An RC that moved
`latest` would be deployed by someone who never intended to run it, so the
publish workflow opts every moving tag in explicitly and only for a stable
version. A prerelease publishes exactly one tag: its own full version.

For production, pin by _digest_. Tags are a naming convenience. Only a digest
names one specific image, and you can't repoint it:

```
ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:<digest>
```

## One-time setup for maintainers

GHCR creates a _private_ package on first publish. It inherits the
repository's visibility only for the linked repository, not for anonymous
pulls. After the first successful release, set the package to public once,
under the package's settings on GitHub. Otherwise every `docker pull` from
outside the organization fails with `denied`.

Nothing in the workflow can do that: package visibility is an account-level
setting, not something the publishing token controls.

## Verify an image

The release workflow publishes two independent artifacts with every image.
Check both, because they answer different questions.

### Provenance attestation: did this repository build the image?

```bash
gh attestation verify \
  oci://ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0 \
  --owner AndrewGoldfinch
```

A passing result means that this repository's release workflow built the image,
from the commit that the attestation names, and that nothing has replaced it
since. A failure means you are holding something else. Don't run it.

That is why nothing publishes images by hand. A manually pushed image has no
attestation, so you can't verify it, and tolerating unverifiable images would
defeat the point of verifying any of them.

### SBOM: what is inside the image?

```bash
docker buildx imagetools inspect \
  ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0 \
  --format '{{ json .SBOM }}'
```

### Confirm the architectures

```bash
docker buildx imagetools inspect ghcr.io/andrewgoldfinch/mud-web-proxy:4.0.0
```

The manifest list names both `linux/amd64` and `linux/arm64`. Entries
with platform `unknown/unknown` are the attestation manifests, not missing
architectures.

## Pin by digest

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

The Compose stack lives in the `compose.yaml` file in the repository root. It
reads `MWP_IMAGE` and skips building from source when that variable is set, so
pinning takes one line in the `.env` file:

```
MWP_IMAGE=ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:<digest>
```

## Upgrade a pinned deployment

Pinning by digest makes upgrades deliberate: resolve the new digest, verify
it, then restart against it. With the preceding Compose stack, that is
`docker compose up -d`; otherwise, re-run the container. Rolling back is the
same operation with the previous digest, which is worth recording somewhere
durable: a digest you can't remember is a rollback you can't perform.
