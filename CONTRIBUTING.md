# Contributing to port2qr

Thanks for helping. Bug reports, documentation fixes, and pull requests are welcome. Report
security issues privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Development setup

You need Node.js 22 or newer and Git. The automated tests use a fake `cloudflared`, so a real one
is only needed to try the CLI by hand.

```bash
git clone https://github.com/kturnal/port2qr.git
cd port2qr
npm install
npm link        # optional: puts your working copy on PATH as `port2qr`
```

`port2qr` has one runtime dependency (`qrcode-terminal`) and no build step. Keep it that way unless
there is a strong reason.

## Tests

```bash
npm run check            # syntax-check the CLI, its modules, and the scripts
npm test                 # every test
npm run test:unit        # unit and package tests (test/*.test.mjs)
npm run test:lifecycle   # CLI lifecycle tests (test/integration/)
```

- The **lifecycle tests** run the real `bin/port2qr.mjs` as a child process with a fake
  `cloudflared` on a private `PATH` and loopback-only origins, and assert output, exit codes, and
  that every owned process is gone afterwards. They need no network access or Cloudflare account,
  and run on Linux, macOS, and Windows.
- On Linux, also run the lifecycle tests under a PID 1 that does not reap orphans, as CI does:

  ```bash
  sudo unshare --pid --fork --mount-proc "$(command -v node)" --test test/integration/cli-lifecycle.test.mjs
  ```

- Add or update tests with every behavior change. New CLI forms need an example in the README; a
  test parses every `port2qr` example there.

## Continuous integration

`.github/workflows/test.yml` runs on every push and pull request with read-only permissions. Its
job names are used as required checks for `main`, so keep them stable:

| Job                                          | Runner  | Runs                                                   |
| -------------------------------------------- | ------- | ------------------------------------------------------ |
| `Unit tests (Node.js 22/24/26)`              | Ubuntu  | `npm run check`, `npm run test:unit`                   |
| `Lifecycle tests (Linux, Node.js 22/24/26)`  | Ubuntu  | `npm run test:lifecycle`, plus the non-reaping PID 1 run |
| `Lifecycle tests (macOS, Node.js 24)`        | macOS   | `npm run test:lifecycle`                               |
| `Lifecycle tests (Windows, Node.js 24)`      | Windows | `npm run test:lifecycle`                               |

Each `22/24/26` row is one job per Node.js version, for example `Unit tests (Node.js 22)`.

When a new Node.js line enters LTS, add it to both matrices; when a line reaches end-of-life, remove
it and raise `engines.node` in `package.json` and `package-lock.json`. `test/runtime-support.test.mjs`
keeps the README, the lockfile, and the CI matrix aligned with `engines.node`.

### Real Quick Tunnel smoke test

`.github/workflows/quick-tunnel-smoke.yml` is run manually (**Actions → Quick Tunnel smoke test → Run
workflow**) and is never a required check. It installs a real `cloudflared`, exposes a disposable
loopback server that only returns a random marker, fetches the marker through the public URL (which
is masked in the log), and verifies that nothing is left running. Run it before each release.

## Pull requests

- Keep each pull request focused on one issue and reference it (`Closes #123`).
- Run `npm run check` and `npm test` before pushing.
- Never weaken the safety rules: user commands run without a shell, origins stay loopback-only, and
  no authenticated or production-tunnel mode is added.

## Releasing

Releases are published by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed. It uses
npm trusted publishing (GitHub Actions OIDC), so no npm token is stored anywhere.

One-time setup (maintainers):

1. On npmjs.com, add a GitHub Actions trusted publisher for `port2qr`: owner `kturnal`, repository
   `port2qr`, workflow `release.yml`, environment `npm`, with direct `npm publish` allowed.
2. Optionally protect the `npm` environment and `v*` tags in the repository settings.

For each release:

1. In a pull request, set the version without creating a tag, then merge it into `main`:

   ```bash
   npm version 1.2.3 --no-git-tag-version
   ```

2. Run the [Quick Tunnel smoke test](#real-quick-tunnel-smoke-test) on `main`.
3. Tag the merged commit on `main` and push the tag:

   ```bash
   git tag v1.2.3 <commit-on-main>
   git push origin v1.2.3
   ```

The workflow then:

1. checks that the tag matches `package.json` and `package-lock.json`, that the commit is on `main`,
   and that the version is not already on npm or released on GitHub;
2. runs `npm run check` and `npm test`, including the package-content test;
3. publishes the exact verified tarball to npm with provenance;
4. creates the GitHub release with generated notes, the tarball, and its SHA-256 checksum.

Re-running the workflow for a version that is already published stops at the first step without
changing anything. If only the GitHub release step failed, re-run that job.
