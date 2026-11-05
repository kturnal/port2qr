# Security policy

## Supported versions

Security fixes are released for the latest published version of `port2qr`. Upgrade to the newest
release before reporting an issue.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security** tab by opening a private
security advisory. Do not include secrets, credentials, access tokens, or private tunnel URLs in a
public issue.

## Exposure model

`port2qr` creates an unauthenticated, temporary public URL. Anyone who obtains that URL can reach the
configured local HTTP service while the command is running, and the URL can be forwarded, logged, or
read from a screen or QR code. There is no authenticated or production-tunnel mode.

Do not use `port2qr` to expose:

- admin panels, databases, or internal dashboards;
- development tools that hold secrets or credentials, such as debuggers or environment viewers;
- applications that serve real customer data or other sensitive information.

To limit what can be exposed, `port2qr` only accepts loopback origins (`localhost`, `127.0.0.0/8`,
or `::1`) without credentials, paths, query strings, or fragments, and runs local commands without a
shell.

The tool checks only whether a standard Cloudflare configuration file exists; it never reads that
file's contents. It does not collect telemetry or upload local files.
