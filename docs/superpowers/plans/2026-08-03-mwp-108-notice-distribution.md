# MWP-108 NOTICE Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing license and attribution files discoverable from the README and ship both files in the runtime container without changing the canonical GPL text.

**Architecture:** Keep `LICENSE` and `NOTICE` as repository-root source artifacts. Admit them through the deny-by-default Docker build context, copy them into the runtime image as immutable root-owned files, and link both from the README. Extend the existing Dockerfile contract test; retain the existing release-bundle contract unchanged.

**Tech Stack:** Markdown, Dockerfile/BuildKit 1.7, Bun 1.3.14, TypeScript, `bun:test`

## Global Constraints

- Leave `LICENSE` byte-for-byte unchanged.
- Keep `NOTICE` content unchanged; MWP-108 distributes and links it but does not revise lineage.
- The container paths are `/opt/mud-web-proxy/LICENSE` and `/opt/mud-web-proxy/NOTICE`.
- Both container files must be owned by root and copied with mode `0444`.
- Do not add dependencies, runtime configuration, directories, or application behavior.
- Do not rewrite README content owned by MWP-110; add only the legal-discoverability section.
- `scripts/build-release-bundle.ts` and `tests/release-bundle.test.ts` already cover the native artifact and require no edits.

## File map

- Modify `.dockerignore`: admit only the two additional root legal files into the Docker build context.
- Modify `Dockerfile`: copy both legal files into the runtime image.
- Modify `tests/docker-image-contract.test.ts`: enforce build-context and runtime-copy behavior.
- Modify `README.md`: link the GPL license and upstream attribution notice.
- Do not modify `LICENSE`, `NOTICE`, `scripts/build-release-bundle.ts`, or `tests/release-bundle.test.ts`.

---

### Task 1: Ship legal files in the runtime image

**Files:**

- Modify: `.dockerignore:1-9`
- Modify: `Dockerfile:33-36`
- Test: `tests/docker-image-contract.test.ts:41-77`

**Interfaces:**

- Consumes: repository-root `LICENSE` and `NOTICE` files.
- Produces: readable `/opt/mud-web-proxy/LICENSE` and `/opt/mud-web-proxy/NOTICE` files in the runtime image; no application code consumes them.

- [ ] **Step 1: Add failing Docker contract assertions**

In `tests/docker-image-contract.test.ts`, extend the runtime-artifact test after the App Attest CA assertion:

```typescript
expect(runtime).toContain('COPY --chown=0:0 --chmod=0444 LICENSE NOTICE ./');
```

Extend the `included` array in the build-context test immediately after
`'!wsproxy.ts'`:

```typescript
      '!LICENSE',
      '!NOTICE',
```

- [ ] **Step 2: Run the focused test and confirm the intended failure**

Run:

```bash
bun test tests/docker-image-contract.test.ts
```

Expected: FAIL because the Dockerfile lacks the legal-file `COPY` instruction
and `.dockerignore` lacks `!LICENSE` and `!NOTICE`.

- [ ] **Step 3: Admit and copy the legal files**

In `.dockerignore`, add the two explicit exceptions after `!wsproxy.ts`:

```dockerignore
!LICENSE
!NOTICE
```

In the Dockerfile runtime stage, add this line after the App Attest CA copy:

```dockerfile
COPY --chown=0:0 --chmod=0444 LICENSE NOTICE ./
```

The existing `WORKDIR /opt/mud-web-proxy` makes `./` resolve to the two paths
required by the design.

- [ ] **Step 4: Run the focused contract test**

Run:

```bash
bun test tests/docker-image-contract.test.ts
```

Expected: all tests in `tests/docker-image-contract.test.ts` PASS.

- [ ] **Step 5: Build the image and inspect the actual files**

Run:

```bash
docker build -t mud-web-proxy:mwp-108 .
docker run --rm --entrypoint cat mud-web-proxy:mwp-108 /opt/mud-web-proxy/LICENSE >/dev/null
docker run --rm --entrypoint cat mud-web-proxy:mwp-108 /opt/mud-web-proxy/NOTICE >/dev/null
```

Expected: the build and both `cat` commands exit `0`.

- [ ] **Step 6: Commit the container contract**

After explicit commit authorization, run:

```bash
git add -- .dockerignore Dockerfile tests/docker-image-contract.test.ts
git diff --cached --check
git commit -m "fix: ship legal notices in the runtime image"
```

### Task 2: Make licensing and attribution discoverable

**Files:**

- Modify: `README.md` at the end of the file

**Interfaces:**

- Consumes: repository-root `LICENSE` and `NOTICE` files.
- Produces: repository landing-page links to both files; no runtime interface.

- [ ] **Step 1: Prove the links are currently absent**

Run:

```bash
rg -n '^## License and attribution$|\[LICENSE\]\(LICENSE\)|\[NOTICE\]\(NOTICE\)' README.md
```

Expected: exit `1` with no matches.

- [ ] **Step 2: Add the minimal README section**

Append this exact section to `README.md`:

```markdown
## License and attribution

mud-web-proxy is licensed under
[GPL-3.0-or-later](LICENSE). See [NOTICE](NOTICE) for upstream authorship and
the attribution required for MIT-derived portions of the project.
```

- [ ] **Step 3: Verify the links and Markdown formatting**

Run:

```bash
rg -n '^## License and attribution$|\[GPL-3\.0-or-later\]\(LICENSE\)|\[NOTICE\]\(NOTICE\)' README.md
bunx prettier --check README.md
```

Expected: `rg` prints three matches and Prettier reports that `README.md` uses
the configured formatting.

- [ ] **Step 4: Commit the README link**

After explicit commit authorization, run:

```bash
git add -- README.md
git diff --cached --check
git commit -m "docs: link license and attribution notice"
```

### Task 3: Verify both supported artifacts and prepare closeout evidence

**Files:**

- Verify only: `LICENSE`, `NOTICE`, `.dockerignore`, `Dockerfile`, `README.md`, `tests/docker-image-contract.test.ts`, `tests/release-bundle.test.ts`

**Interfaces:**

- Consumes: the completed container and README changes from Tasks 1 and 2.
- Produces: reproducible MWP-108 verification evidence for the Linear completion comment.

- [ ] **Step 1: Run both distribution contract suites**

Run:

```bash
bun test tests/docker-image-contract.test.ts tests/release-bundle.test.ts
```

Expected: all Docker image and native release bundle tests PASS. The release
bundle test must report passing cases for both `includes LICENSE` and
`includes NOTICE`.

- [ ] **Step 2: Verify discoverability and immutable-license scope**

Run:

```bash
rg -n 'LICENSE|NOTICE' README.md Dockerfile .dockerignore
git diff HEAD~2 -- LICENSE NOTICE
git diff --check
```

Expected: the first command shows README links, Docker build-context exceptions,
and the runtime copy. The second and third commands print no output.

- [ ] **Step 3: Confirm the worktree contains only intended changes**

Run:

```bash
git status --short --branch
git log --oneline -3
```

Expected: the worktree is clean. The latest two implementation commits are the
container legal-file contract and the README legal links; the reviewed design
commit remains immediately before them.

- [ ] **Step 4: Record Linear closeout after the implementation lands on `main`**

Add a comment to MWP-108 containing the focused test command and results, the
actual container-file checks, and this design decision:

```markdown
`LICENSE` remains the unmodified canonical GPLv3 text required by MWP-107.
`README.md` links `LICENSE` and `NOTICE` together, and both supported
distribution artifacts carry both files. This replaces the contradictory
criterion that the canonical license text itself be edited to reference
`NOTICE`.
```

Only after the authorized PR is merged and `origin/main` contains the changes,
move MWP-108 to Done. Do not mark it Done from an unpublished local branch.
