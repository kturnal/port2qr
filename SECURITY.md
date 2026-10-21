# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security** tab by opening a private
security advisory. Do not include secrets, credentials, access tokens, or private tunnel URLs in a
public issue.

## Exposure model

`port2qr` creates an unauthenticated, temporary public URL. Anyone who obtains that URL can reach the
configured local HTTP service while the command is running. Do not expose admin panels, databases,
development tools containing secrets, or applications with sensitive data.

The tool checks only whether a standard Cloudflare configuration file exists; it never reads that
file's contents. It does not collect telemetry or upload local files.
