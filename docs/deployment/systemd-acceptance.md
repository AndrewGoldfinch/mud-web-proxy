# Systemd acceptance

Run this procedure only on a disposable Basic one-vCPU, 1 GiB DigitalOcean
Droplet created from `ubuntu-26-04-x64`. It installs a synthetic release, test App
Attest identifiers, and a test `{}` App Attest store. Production
configuration, hostnames, secrets, and App Attest keys never enter this test.

This procedure is host acceptance for the shipped systemd and Caddy artifacts,
not the production state-transfer or rollback procedure. Those gates remain in
[New-Droplet production cutover](new-droplet-cutover.md).

## Prerequisites and host refusal

Run as root from a real Git checkout of the exact commit being accepted. The
checkout must have no tracked changes; untracked dependency caches are
allowed. If you copy the source to the host rather than cloning it, transfer a Git
bundle and clone that bundle, so that `HEAD` remains independently verifiable. The
checkout needs the exact Bun release in `.bun-version` on `PATH` and frozen
dependencies installed. Confirm the source, OS, architecture, and 1 GiB
class before the run:

```bash
source /etc/os-release
test -z "$(git status --porcelain=v1 --untracked-files=no)"
test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
git rev-parse --verify 'HEAD^{commit}'
test "${ID}" = ubuntu
test "${VERSION_ID}" = 26.04
test "$(uname -m)" = x86_64
test "$(awk '/MemTotal/ {print ($2 >= 900000 && $2 <= 1200000)}' /proc/meminfo)" = 1
test "$(nproc)" = 1
```

On the control-plane machine, retain only the non-network fields from the
exact Droplet response, then copy that JSON to the test host as a root-owned
mode-0600 file. Don't retain the raw response, because it contains network
addresses:

```bash
doctl compute droplet get "$DROPLET_ID" --output json |
  jq --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.[0] | {
      dropletId: .id,
      name,
      regionSlug: .region.slug,
      imageSlug: .image.slug,
      sizeSlug: .size_slug,
      memoryMiB: .memory,
      vcpus,
      diskGiB: .disk,
      status,
      capturedAt: $capturedAt
    }' >digitalocean-control-plane.json
```

Copy it to `/root/mwp-105-digitalocean-control-plane.json` on the disposable
host and set `MWP_DIGITALOCEAN_EVIDENCE_PATH` to that path. The runner queries
DigitalOcean's fixed on-host Droplet-ID metadata endpoint with the system curl
binary and bounded timeouts, requires one positive decimal ID, and requires
that ID to equal the control-plane `dropletId`. The endpoint value is neither an
operator input nor retained evidence. The runner rejects anything except the
exact `ubuntu-26-04-x64`, `s-1vcpu-1gb`, 1,024 MiB, one-vCPU, 25 GiB active
acceptance shape, and independently checks the host's visible CPU and memory.
It retains the on-host ID, exact clean Git `HEAD`, and a SHA-256 manifest for
the entire tracked checkout before installing or building anything.

The install phase downloads Node 22.21.1 from the official Node distribution,
verifies its archive against the official `SHASUMS256.txt`, and extracts it
under `/root` solely to run the two acceptance clients. The procedure doesn't install Node
in a system path, copy it into the synthetic release, or use it in the systemd
unit. The application release and service remain pinned to Bun 1.3.14.

The install phase refuses to run if any of these production-shaped paths
exists. The acknowledgment can't override this check:

```text
/opt/mud-web-proxy
/etc/mud-web-proxy.env
/var/lib/mud-web-proxy
/var/lib/mud-web-proxy-deploy
```

Its acknowledgment value is exact:

```text
ERASE THIS CLEAN UBUNTU 26.04 VM
```

The runner creates `/root/mwp-105-evidence-<UTC timestamp>` and a root-only
resume pointer at `/root/mwp-105-acceptance-resume`. Preserve both between a
successful install phase and its post-reboot phase.

## First run: measure without a threshold

From the checkout, run measurement mode exactly as follows. It requires a
systemd security result in the `OK` band, saves the unthresholded report, and
doesn't claim that a baseline gate passed.

```bash
sudo env \
  PATH="$PATH" \
  MWP_DIGITALOCEAN_EVIDENCE_PATH=/root/mwp-105-digitalocean-control-plane.json \
  MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' \
  MWP_SECURITY_MODE=measure \
  MWP_ACCEPTANCE_PHASE=install \
  bash tests/deployment/run-systemd-acceptance.sh
```

This phase runs `systemd-analyze verify`, formats and validates Caddy, then
exercises loopback health, HTTPS, WSS, spoofed-header replacement, shutdown,
and explicit proxy/Caddy restarts. Success prints the evidence directory and
`systemd-acceptance: reboot required`.

Before rebooting, repeat that identical install command. It must fail with
`refusing non-clean host`, create no new evidence directory, leave the resume
pointer unchanged, and neither stop nor restart enabled test services. Retain
this output as proof that the acknowledgment can't reuse an installation.

Reboot from the Droplet console or SSH session, reconnect, return to the same
checkout, and run the second phase:

```bash
sudo systemctl reboot
```

```bash
sudo env PATH="$PATH" MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' MWP_SECURITY_MODE=measure MWP_ACCEPTANCE_PHASE=post-reboot bash tests/deployment/run-systemd-acceptance.sh
```

The runner doesn't reboot its own SSH session. `post-reboot` requires the
root-only resume pointer, a changed boot ID, both services enabled and active,
both health paths, and a loopback-only proxy socket. It writes
`evidence-complete` in the original evidence directory.

## Convert measurement to a checked-in baseline

Retain the complete first-run evidence. Set `EVIDENCE_DIR` to the one
directory printed by the measurement run. Create the
`tests/deployment/systemd-security-baseline.json` file from its captured
`systemd-security-measurement.json` file. Don't re-query a mutable live package
or score after the run. The retained `systemd-security.txt` corroborates the
captured score and supplies the residual assessments.

```bash
set -euo pipefail
: "${EVIDENCE_DIR:?set this to the measurement evidence directory}"
[[ "$EVIDENCE_DIR" == /root/mwp-105-evidence-* ]]
[[ -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" ]]
measurement_json="$EVIDENCE_DIR/systemd-security-measurement.json"
security_report="$EVIDENCE_DIR/systemd-security.txt"
[[ -f "$measurement_json" && ! -L "$measurement_json" && -s "$measurement_json" ]]
[[ -f "$security_report" && ! -L "$security_report" && -s "$security_report" ]]
measurement_fields="$(MEASUREMENT_JSON="$measurement_json" bun -e '
  const value = await Bun.file(Bun.env.MEASUREMENT_JSON).json();
  if (value.image !== "ubuntu-26-04-x64" || value.osVersion !== "26.04" ||
      value.architecture !== "x86_64" ||
      typeof value.systemdPackage !== "string" ||
      !/^[0-9]/.test(value.systemdPackage) ||
      !Number.isFinite(value.measuredExposure) ||
      !Number.isInteger(value.measuredExposure * 10)) {
    throw new Error("invalid captured security measurement");
  }
  process.stdout.write([value.systemdPackage, value.measuredExposure].join("\t"));
')"
IFS=$'\t' read -r systemd_package measured_exposure extra <<<"$measurement_fields"
[[ -n "$systemd_package" && "$measured_exposure" =~ ^[0-9]+\.[0-9]$ && -z "${extra:-}" ]]
report_exposure="$(sed -nE 's/.*Overall exposure level for mud-web-proxy.service: ([0-9]+\.[0-9]+).*/\1/p' "$security_report")"
[[ "$report_exposure" == "$measured_exposure" ]]
maximum_exposure="$(awk -v score="${measured_exposure}" 'BEGIN { printf "%.1f", score + 0.1 }')"
[[ "$maximum_exposure" =~ ^[0-9]+\.[0-9]$ ]]
```

The JSON records literal `image: "ubuntu-26-04-x64"`, `osVersion: "26.04"`,
and `architecture: "x86_64"`, the captured `systemdPackage`, numeric
`measuredExposure`, numeric `maximumExposure`, and one specific residual
explanation for every failed systemd assessment. The maximum is exactly the
measured exposure plus `0.1`. It is a regression threshold, never a value
recalculated from a later host. Each residual names the actual assessment and
explains whether it is required application networking, inapplicable to the
locked non-root service, or a measured compatibility deferral. An unexplained
residual blocks acceptance.

### Recorded Ubuntu 26.04 measurement

The completed clean-host measurement used systemd `259.5-0ubuntu3`. Its
exposure was `2.8` in the `OK` band, so the checked-in regression maximum is
`2.9`. The hostname-based `mwp-mud.test` session succeeded with
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, so `AF_NETLINK` is not
required.

The 50-session workload sustained bidirectional traffic for at least 60
seconds and every client observed close code 1001 with reason
`Server restarting`. The resource capture was:

| Property        | Measured value |
| --------------- | -------------- |
| `MemoryCurrent` | 36,569,088 B   |
| `MemoryPeak`    | 37,359,616 B   |

The original task and descriptor values were single post-sustain snapshots
rather than peaks, so they are not load-bearing acceptance evidence. The clean
fix-round verification retained 395 bounded samples over 67,680 ms from
before load launch through the inactive drain state. Its complete series
recorded `TaskPeak=7` and `FileDescriptorPeak=118`, below the respective 128
and 1,024 limits.

The unit-before, parent-before, load, and terminal parent `memory.events`
captures all recorded `low=0`, `high=0`, `max=0`, `oom=0`, `oom_kill=0`,
`oom_group_kill=0`, and `sock_throttled=0`. No counter incremented during the
workload or graceful shutdown. The 37,359,616-byte peak leaves substantially
more than 20% headroom below `MemoryMax=512M`, so the measured profile
doesn't require a resource-limit revision.

## Final run: verify the recorded threshold

Measurement changes the first VM. Create a new clean `ubuntu-26-04-x64`
Droplet, or rebuild the first Droplet from that image after copying evidence
and committing the baseline. Then run:

```bash
sudo env \
  PATH="$PATH" \
  MWP_DIGITALOCEAN_EVIDENCE_PATH=/root/mwp-105-digitalocean-control-plane.json \
  MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' \
  MWP_SECURITY_MODE=verify \
  MWP_ACCEPTANCE_PHASE=install \
  bash tests/deployment/run-systemd-acceptance.sh
```

Verification rejects a missing baseline, host or systemd package mismatch, a
non-`OK` assessment, or a score above the recorded maximum. It runs
`systemd-analyze security
--threshold=<maximumExposure-times-10-as-an-integer>`. The JSON remains on
systemd's human-readable 0-10 scale, and only the CLI boundary converts the
strict one-decimal value to systemd 259's integer percentage, so that `2.9`
becomes `29`. It doesn't derive a new maximum. It also parses every live failed-assessment
identifier and requires exact sorted equality with the baseline: Duplicates,
missing identifiers, extras, and unparseable failure lines all block
acceptance. The runner retains the comparison JSON before it reports either a
threshold failure or a residual mismatch, so a failed verification preserves
the exact delta.
On success, reboot from the current SSH or console session:

```bash
sudo systemctl reboot
```

After the Droplet reconnects, return to the same checkout and run the
post-reboot phase. Don't paste this command into the pre-reboot shell block:

```bash
sudo env PATH="$PATH" MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' MWP_SECURITY_MODE=verify MWP_ACCEPTANCE_PHASE=post-reboot bash tests/deployment/run-systemd-acceptance.sh
```

Acceptance completes only when post-reboot exits zero and the original
evidence directory contains `evidence-complete`.

## Review the evidence

Copy the evidence directory off the Droplet before cleanup. Review the
`host.txt`, `systemd-verify.txt`, and `systemd-security.txt` files, and the
measurement JSON; `digitalocean-control-plane.json`, `digitalocean-on-host-id.txt`,
`source-identity.txt`, `source-files.sha256`, `release-artifacts.sha256`,
`systemd-security-residuals.json`, `resources.txt`, `resource-samples.tsv`,
`resource-peaks.txt`, `resource-sampler.log`, all `memory-events-*.txt` files,
`memory-events-cgroups.txt`, `port-6200.txt`, `mock-mud-firewall.txt`, and
`mock-mud.log`, `mount-boundary.txt`, and `caddy-local-root.crt`; the
`node-acceptance-runtime.txt`, `node-SHASUMS256.txt`, and
`node-client-build.json`; the
`acceptance-client.log`, `load-client.log`, and `restart-wss-client.log`; the
`spoof-probe-journal.txt`, `mud-web-proxy-journal.txt`, and
`system-journal.txt`; and `pre-reboot-status.txt`, `pre-reboot-journal.txt`,
`post-reboot-status.txt`, `post-reboot-journal.txt`, `post-reboot-sockets.txt`,
`install-boot-id`, `boot-ids.txt`, and `evidence-complete`. The boot-ID pair
must contain distinct valid install and post-reboot IDs. The journals must include
`shutdown: completed`, and they must not show read-only filesystem, timeout,
deadline, SIGKILL, OOM, or state-flush failures.

Require the `dropletId` in `digitalocean-control-plane.json` to equal the
single decimal line in `digitalocean-on-host-id.txt`. Require the `git-head`
in `source-identity.txt` to equal the full commit under review and
`tracked-checkout-clean=yes`. Materialize that exact commit into a temporary
directory and run `sha256sum --check` there with `source-files.sha256`. That
comparison checks every retained tracked-file hash against the reviewed commit
rather than against the operator's current checkout. Build that checkout with the pinned Bun
and frozen dependencies, then require `release-artifacts.sha256` to match the
rebuilt `dist/wsproxy.js`.

The load client must record `50 sessions ready`, `sustained`, and graceful
close. It carries periodic bidirectional WebSocket-to-mock-MUD traffic for at least
60 seconds, which is a repeatable lower bound rather than proof of the
200-session cap.
Require `FileDescriptorPeak` below 1024, `TaskPeak` below 128, a sample series
that begins while active and ends inactive, and no `max`, `oom`, or `oom_kill`
`memory.events` increment. A `high` increment, or less than 20%
observed headroom below 512 MiB, requires resource-design review. Don't raise
the limit on its own.

### Hostname diagnostic branch

The normal run uses `TN_HOST=mwp-mud.test`, never an IP literal. If its
hostname-based WSS-to-MUD session fails, retain the service journal and socket
error, then repeat the identical target once with `TN_HOST` set to the already
verified test IP solely as a diagnostic. If the IP succeeds, test
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`; add
`AF_NETLINK` only if the hostname test then succeeds. Record the decision and
residual explanation, discard the VM, and repeat measurement from a new clean
VM. If the IP diagnostic also fails, don't add `AF_NETLINK`, because the cause is
not isolated to hostname resolution.

## Cleanup

After copying the final evidence and retaining the material used for the
baseline, delete every disposable test Droplet through the normal DigitalOcean
control plane. Confirm deletion by Droplet ID. Don't leave a billed VM with
test state.
