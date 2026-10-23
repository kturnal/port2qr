# port2qr

Expose a local web server through a temporary HTTPS Cloudflare Quick Tunnel and print a QR code you
can scan on a phone.

```text
Local server → cloudflared → temporary HTTPS URL → terminal QR code → phone
```

## Requirements

- Node.js 22 or newer
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
  installed and available on `PATH`
- An internet connection

Runtime support follows the maintained Node.js LTS lines, and support for a release line ends when
it reaches upstream end-of-life.

Cloudflare Quick Tunnels do not require a Cloudflare account, token, domain, or inbound firewall
rule. They are intended for development and testing, not production hosting.

## Install

Install directly from GitHub:

```bash
npm install --global github:kturnal/port2qr
```

Or clone the repository and link the command locally:

```bash
git clone https://github.com/kturnal/port2qr.git
cd port2qr
npm install
npm link
```

## Use

Tunnel a server that is already running on port 3000:

```bash
port2qr 3000
```

Start a project's development server and tunnel it with one command:

```bash
port2qr 5173 -- npm run dev
```

The arguments after `--` are passed directly to the program without a shell. Press Ctrl+C to stop
the local command and tunnel. The random `trycloudflare.com` URL expires when the tunnel stops.

Use a custom local origin or Host header:

```bash
port2qr --url http://localhost:8080
port2qr 8080 --host-header localhost:8080
port2qr 8080 --no-host-header
```

For safety, custom origins must be loopback addresses (`localhost`, `127.0.0.0/8`, or `::1`) and
must not contain credentials, paths, query strings, or fragments.

Run `port2qr --help` for all options.

## Security

The generated URL is public and unauthenticated. Anyone who has it can access the local service while
`port2qr` is running. Do not expose admin interfaces, databases, secret-bearing development tools, or
sensitive customer data. See [SECURITY.md](SECURITY.md) for the reporting policy and exposure model.

`port2qr` does not read Cloudflare credentials or configuration contents. Cloudflare currently does
not support Quick Tunnels when `~/.cloudflared/config.yml` or `config.yaml` exists, so the command
stops with an explanatory error if either file is present.

## Development

```bash
npm install
npm run check
npm test
```

On Linux, `port2qr` and the lifecycle tests read `/proc` to tell zombie processes from live ones, so
no init process is required in containers whose PID 1 does not reap orphans. This needs `/proc`
mounted for the container's PID namespace, as Docker and `unshare --mount-proc` do; otherwise run
the container with `docker run --init`. CI checks this case with:

```bash
sudo unshare --pid --fork --mount-proc "$(command -v node)" --test test/cli-lifecycle.test.mjs
```

## License

[MIT](LICENSE)
