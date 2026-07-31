# Systemd acceptance

Run this only on a disposable Basic one-vCPU, one-GiB DigitalOcean Droplet
created from `ubuntu-26-04-x64`. It installs a synthetic release, test App
Attest identifiers, and a test `{}` App Attest store. Production
configuration, hostnames, secrets, and App Attest keys never enter this test.

This is host acceptance for the shipped systemd/Caddy artifacts, not the
production state-transfer or rollback procedure. Those gates remain in the
[New-Droplet cutover runbook](new-droplet-cutover.md).

## Prerequisites and host refusal

Run as root from a checkout of the branch being accepted. The checkout needs
the exact Bun release in `.bun-version` on `PATH` and frozen dependencies
installed. Confirm the OS, architecture, and one-GiB class before the run:

```bash
source /etc/os-release
test "${ID}" = ubuntu
test "${VERSION_ID}" = 26.04
test "$(uname -m)" = x86_64
test "$(awk '/MemTotal/ {print ($2 >= 900000 && $2 <= 1200000)}' /proc/meminfo)" = 1
```

The install phase downloads Node 22.21.1 from the official Node distribution,
verifies its archive against the official `SHASUMS256.txt`, and extracts it
under `/root` solely to run the two acceptance clients. Node is not installed
in a system path, copied into the synthetic release, or used by the systemd
unit. The application release and service remain pinned to Bun 1.3.14.

The install phase refuses to run if any of these production-shaped paths
exists. The acknowledgement cannot override this check:

```text
/opt/mud-web-proxy
/etc/mud-web-proxy.env
/var/lib/mud-web-proxy
/var/lib/mud-web-proxy-deploy
```

Its acknowledgement value is exact:

```text
ERASE THIS CLEAN UBUNTU 26.04 VM
```

The runner creates `/root/mwp-105-evidence-<UTC timestamp>` and a root-only
resume pointer at `/root/mwp-105-acceptance-resume`. Preserve both between a
successful install phase and its post-reboot phase.

## First run: measure without a threshold

From the checkout, run measurement mode exactly as follows. It requires a
systemd security result in the `OK` band, saves the unthresholded report, and
does not claim that a baseline gate passed.

```bash
sudo env PATH="$PATH" MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' MWP_SECURITY_MODE=measure MWP_ACCEPTANCE_PHASE=install bash tests/deployment/run-systemd-acceptance.sh
```

This phase runs `systemd-analyze verify`, formats and validates Caddy, then
exercises loopback health, HTTPS, WSS, spoofed-header replacement, shutdown,
and explicit proxy/Caddy restarts. Success prints the evidence directory and
`systemd-acceptance: reboot required`.

Before rebooting, repeat that identical install command. It must fail with
`refusing non-clean host`, create no new evidence directory, leave the resume
pointer unchanged, and neither stop nor restart enabled test services. Retain
this output as proof that the acknowledgement cannot reuse an installation.

Reboot from the Droplet console or SSH session, reconnect, return to the same
checkout, and run the second phase:

```bash
sudo systemctl reboot
```

```bash
sudo env PATH="$PATH" MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' MWP_SECURITY_MODE=measure MWP_ACCEPTANCE_PHASE=post-reboot bash tests/deployment/run-systemd-acceptance.sh
```

The runner does not reboot its own SSH session. `post-reboot` requires the
root-only resume pointer, a changed boot ID, both services enabled and active,
both health paths, and a loopback-only proxy socket. It writes
`evidence-complete` in the original evidence directory.

## Convert measurement to a checked-in baseline

Retain the complete first-run evidence. Set `EVIDENCE_DIR` to the one
directory printed by the measurement run. Create
`tests/deployment/systemd-security-baseline.json` from its captured
`systemd-security-measurement.json`; do not re-query a mutable live package or
score after the run. The retained `systemd-security.txt` corroborates the
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
measured exposure plus `0.1`; it is a regression threshold, never a value
recalculated from a later host. Each residual names the actual assessment and
explains whether it is required application networking, inapplicable to the
locked non-root service, or a measured compatibility deferral. An unexplained
residual blocks acceptance.

## Final run: verify the recorded threshold

Measurement changes the first VM. Create a new clean `ubuntu-26-04-x64`
Droplet, or rebuild the first Droplet from that image after copying evidence
and committing the baseline. Then run:

```bash
sudo env PATH="$PATH" MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' MWP_SECURITY_MODE=verify MWP_ACCEPTANCE_PHASE=install bash tests/deployment/run-systemd-acceptance.sh
```

Verification rejects a missing baseline, host or systemd package mismatch, a
non-`OK` assessment, or a score above the recorded maximum. It runs
`systemd-analyze security --threshold=<maximumExposure>`; it does not derive a
new threshold. On success, reboot from the current SSH or console session:

```bash
sudo systemctl reboot
```

After the Droplet reconnects, return to the same checkout and run the
post-reboot phase. Do not paste this command into the pre-reboot shell block:

```bash
sudo env PATH="$PATH" MWP_DISPOSABLE_VM_ACK='ERASE THIS CLEAN UBUNTU 26.04 VM' MWP_SECURITY_MODE=verify MWP_ACCEPTANCE_PHASE=post-reboot bash tests/deployment/run-systemd-acceptance.sh
```

Acceptance completes only when post-reboot exits zero and the original
evidence directory contains `evidence-complete`.

## Review the evidence

Copy the evidence directory off the Droplet before cleanup. Review
`host.txt`, `systemd-verify.txt`, `systemd-security.txt`, and the measurement
JSON; `resources.txt`, all `memory-events-*.txt` files,
`memory-events-cgroups.txt`, `port-6200.txt`, `mock-mud-firewall.txt`, and
`mock-mud.log`, `mount-boundary.txt`, and `caddy-local-root.crt`; the
`node-acceptance-runtime.txt`, `node-SHASUMS256.txt`, and
`node-client-build.json`; the
`acceptance-client.log`, `load-client.log`, and `restart-wss-client.log`; the
`spoof-probe-journal.txt`, `mud-web-proxy-journal.txt`, and
`system-journal.txt`; and `pre-reboot-status.txt`, `pre-reboot-journal.txt`,
`post-reboot-status.txt`, `post-reboot-journal.txt`, `post-reboot-sockets.txt`,
`install-boot-id`, and `evidence-complete`. The journals must include
`shutdown: completed` and must not show read-only filesystem, timeout,
deadline, SIGKILL, OOM, or state-flush failures.

The load client must record `50 sessions ready`, `sustained`, and graceful
close. It has periodic bidirectional WebSocket-to-mock-MUD traffic for at
least 60 seconds: a repeatable lower bound, not proof of the 200-session cap.
Require descriptors below 1024, tasks below 128, and no `max`, `oom`, or
`oom_kill` `memory.events` increment. A `high` increment or less than 20%
observed headroom below 512 MiB requires resource-design review; do not merely
raise the limit.

### Hostname diagnostic branch

The normal run uses `TN_HOST=mwp-mud.test`, never an IP literal. If its
hostname-based WSS-to-MUD session fails, retain the service journal and socket
error, then repeat the identical target once with `TN_HOST` set to the already
verified test IP solely as a diagnostic. If the IP succeeds, test
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`; add
`AF_NETLINK` only if the hostname test then succeeds. Record the decision and
residual explanation, discard the VM, and repeat measurement from a new clean
VM. If the IP diagnostic also fails, do not add `AF_NETLINK`: the cause is not
isolated to hostname resolution.

## Cleanup

After copying the final evidence and retaining the material used for the
baseline, delete every disposable test Droplet through the normal DigitalOcean
control plane. Confirm deletion by Droplet ID; do not leave a billed VM with
test state.
