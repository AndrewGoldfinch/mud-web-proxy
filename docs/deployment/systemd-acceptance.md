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

Retain the complete first-run evidence. Create
`tests/deployment/systemd-security-baseline.json` from exactly one retained
`systemd-security.txt`; capture the package and score rather than
transcribing them:

```bash
systemd_package="$(dpkg-query -W -f='${Version}\n' systemd)"
security_report="$(find /root -maxdepth 2 -type f -path '/root/mwp-105-evidence-*/systemd-security.txt' -print)"
test "$(printf '%s\n' "${security_report}" | wc -l)" -eq 1
measured_exposure="$(sed -nE 's/.*Overall exposure level for mud-web-proxy.service: ([0-9]+\.[0-9]+).*/\1/p' "${security_report}")"
test "$(printf '%s\n' "${measured_exposure}" | wc -l)" -eq 1
maximum_exposure="$(awk -v score="${measured_exposure}" 'BEGIN { printf "%.1f", score + 0.1 }')"
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
new threshold. On success, reboot, reconnect, and complete the second phase:

```bash
sudo systemctl reboot
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
