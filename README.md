# port2qr

Expose a local web server through a temporary HTTPS Cloudflare Quick Tunnel and print a QR code you
can scan on a phone.

```text
Local server → cloudflared → temporary HTTPS URL → terminal QR code → phone
```

> [!WARNING]
> The generated URL is **public and unauthenticated**. Anyone who has it can reach your local
> service while `port2qr` is running. Never expose admin interfaces, databases, development tools
> that hold secrets, or real customer data. See [Security](#security).

## Requirements

- **Node.js 22, 24, or 26.** Runtime support follows the maintained Node.js LTS lines: each release
  line is supported until it reaches upstream end-of-life. Node.js 22 or newer is required.
- **A desktop operating system:** macOS, Windows, or Linux. CI exercises the full process lifecycle
  on the current GitHub-hosted macOS, Windows, and Ubuntu runners.
- **[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)**
  installed and on `PATH` (see below).
- An internet connection. No Cloudflare account, token, domain, or inbound firewall rule is needed.

Quick Tunnels are intended for development and testing, not production hosting.

### Install cloudflared

Follow Cloudflare's official
[downloads page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
Common options are:

```bash
brew install cloudflared                      # macOS (Homebrew)
winget install --id Cloudflare.cloudflared    # Windows
```

On Linux, use Cloudflare's package repository or a release binary from the downloads page. Check
the installation with `cloudflared --version`.

## Install

Until v1.0.0 is published to npm, install from GitHub:

```bash
npm install --global github:kturnal/port2qr
```

Once [`port2qr`](https://www.npmjs.com/package/port2qr) is available on npm, install the released
package instead:

```bash
npm install --global port2qr
```

Or clone the repository and link the command locally:

```bash
git clone https://github.com/kturnal/port2qr.git
cd port2qr
npm install
npm link
```

Check the installation:

```bash
port2qr --version
```

## Use

### Tunnel a server that is already running

```bash
port2qr 3000
port2qr --port 3000
```

`port2qr` waits until `http://127.0.0.1:3000/` answers, starts the tunnel, and prints the URL and a
QR code. It never starts or stops a server it does not own: when you press Ctrl+C, only the tunnel
stops.

### Start the server and tunnel it with one command

```bash
port2qr 5173 -- npm run dev
port2qr --url http://localhost:8080 -- node server.js
```

Everything after `--` is the command, passed directly to the program without a shell, so shell
syntax such as `&&`, `|`, or `$VAR` is not interpreted. If the origin already responds before the
command starts, `port2qr` stops with an error instead of starting a second server; omit the command
to tunnel the existing one.

`port2qr` owns the command: it waits for the origin to answer, then starts the tunnel, and stops the
command again when the tunnel stops. On Windows, `npm` and `npx` run through their JavaScript entry
points because Windows cannot start their `.cmd` shims without a shell; run other `.cmd` or `.bat`
tools through `npm run` or their `node` entry point.

### Choose the origin and Host header

```bash
port2qr --url http://127.0.0.1:8080
port2qr --url https://localhost:8443
port2qr 8080 --host-header localhost:8080
port2qr 8080 --no-host-header
port2qr 3000 --timeout 120
```

- **Origin.** A port means `http://127.0.0.1:<port>`. With `--url`, the origin may use `http://` or
  `https://`, but it must be a loopback address (`localhost`, `127.0.0.0/8`, or `[::1]`) and must not
  contain credentials, a path, a query string, or a fragment.
- **Host header.** By default the local server receives the origin's own host (for example
  `127.0.0.1:8080`), which development servers that check allowed hosts accept. Use
  `--host-header <value>` to send a different value, or `--no-host-header` to pass through the public
  `*.trycloudflare.com` host unchanged.
- **Timeout.** `--timeout` (1–600 seconds, default 60) applies separately to waiting for the origin
  and to waiting for the tunnel URL.

Run `port2qr --help` for the full option list.

### Local HTTPS origins

`port2qr` and `cloudflared` both verify the origin's TLS certificate, so an `https://` origin needs
a certificate that both trust; a self-signed certificate makes `port2qr` time out waiting for the
origin. With a local certificate authority such as [mkcert](https://github.com/FiloSottile/mkcert),
run `mkcert -install`, issue the certificate for `localhost`, and let Node.js trust the same
authority:

```bash
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" port2qr --url https://localhost:8443
```

Serving plain `http://` locally is usually simpler: visitors still reach the tunnel over HTTPS.

## Stopping, exit codes, and cleanup

Press Ctrl+C (or send `SIGTERM` or `SIGHUP`) to stop. The random `trycloudflare.com` URL stops
working when the tunnel stops.

| Situation                                                           | Exit code |
| ------------------------------------------------------------------- | --------- |
| Stopped with Ctrl+C, `SIGTERM`, or `SIGHUP`                         | `0`       |
| Invalid arguments                                                   | `1`       |
| `cloudflared` missing, or a Cloudflare configuration file conflicts | `1`       |
| The origin or tunnel URL does not appear within the timeout         | `1`       |
| The owned command or `cloudflared` exits unexpectedly               | `1`       |

On every path, `port2qr` stops each process it started, including their descendants (such as the
server that `npm run dev` starts), before it exits. If one of them exits unexpectedly, the other is
stopped as well.

- **macOS and Linux:** the command and `cloudflared` run in their own process groups. `port2qr`
  sends `SIGTERM` to each group, then `SIGKILL` to anything still running after 3 seconds.
- **Windows:** each process tree is ended with `taskkill /T /F`. Windows has no catchable
  termination signal for console programs, so this stop is immediate.
- **Containers:** on Linux, `port2qr` reads `/proc` to tell exited (zombie) processes from running
  ones, so it works without an init process when `/proc` is mounted for the container's PID
  namespace, as Docker and `unshare --mount-proc` do. Otherwise, run the container with
  `docker run --init`.

Cleanup can only run while `port2qr` itself runs: if it is killed with `SIGKILL` (or ended from Task
Manager), stop the remaining processes yourself.

## Security

The generated URL is public and unauthenticated. Anyone who has it can access the local service while
`port2qr` is running, and links can be forwarded, logged, or captured from a screen or QR code.

**Do not use `port2qr` to expose:**

- admin panels, databases, or internal dashboards;
- development tools that hold secrets or credentials, such as debuggers or environment viewers;
- applications that serve real customer data or other sensitive information.

Expose only content you would be comfortable publishing, and stop `port2qr` as soon as you are done.
There is no authenticated or production-tunnel mode.

`port2qr` does not read Cloudflare credentials or configuration contents, collect telemetry, or upload
local files. See [SECURITY.md](SECURITY.md) for the exposure model and how to report a vulnerability.

### Cloudflare configuration file

Cloudflare does not support Quick Tunnels when `~/.cloudflared/config.yml` or `config.yaml` exists
(`%USERPROFILE%\.cloudflared\` on Windows), so `port2qr` stops with an explanatory error if either
file is present. It only checks that the file exists; it never reads it. Temporarily move the file,
run `port2qr`, then move it back.

## Troubleshooting

- **`cloudflared is not installed or is not on PATH`.** Install `cloudflared` (see
  [Install cloudflared](#install-cloudflared)) and open a new terminal so `PATH` is refreshed.
- **`Quick Tunnels do not support ~/.cloudflared/config.yml`.** See
  [Cloudflare configuration file](#cloudflare-configuration-file).
- **`The origin did not become ready … within 60 seconds`.** Check that the server listens on the
  same port and on a loopback address. Many servers listen on `localhost`, which can resolve to
  `::1` only; try `port2qr --url http://localhost:<port>` or `--url http://[::1]:<port>`. For slow
  builds, raise `--timeout`. For HTTPS origins, see [Local HTTPS origins](#local-https-origins).
- **`The origin is already responding`.** A server already listens on that port; drop the command
  after `--` to tunnel it, or choose another port.
- **`Cloudflare did not provide a Quick Tunnel URL`** or **`Cloudflare Tunnel exited
  unexpectedly`.** `port2qr` prints the recent `cloudflared` output below the error. Check your
  internet connection and that outbound traffic to Cloudflare is not blocked by a firewall, VPN, or
  proxy, then try again; Quick Tunnels are a free service without uptime guarantees.
- **The page loads but the app rejects the request** (for example "Invalid Host header" or a
  blocked host). Keep the default Host header, or set the one your server expects with
  `--host-header`.
- **The phone shows a Cloudflare error page.** The tunnel is up but the origin is not answering;
  check the server's own output.

## Contributing

Bug reports and pull requests are welcome. See the
[contributing guide](https://github.com/kturnal/port2qr/blob/main/CONTRIBUTING.md) for
development, testing, and release instructions.

## License

[MIT](LICENSE)
