# Security Policy

## Scope

OB Transfer is a self-hosted file transfer application with authentication, file uploads, media previews, realtime events, and local runtime storage.

Security issues involving authentication, authorization, file access, path traversal, upload handling, XSS, CSRF/CORS behavior, Socket.IO authorization, session handling, resource exhaustion, or sensitive-data exposure are in scope.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the project maintainer rather than opening a public GitHub issue.

When reporting an issue, include:

- affected version or commit
- affected endpoint or component
- concise reproduction steps
- expected behavior
- observed behavior
- security impact
- any proof-of-concept needed to reproduce the issue safely

Do not include real passwords, private uploaded files, session cookies, or other secrets in a report.

## Security expectations for deployments

Operators should:

- use a strong unique `ACCESS_PASSWORD`
- keep `.env` private
- use HTTPS in production
- configure an exact `APP_URL`
- restrict access at the network/reverse-proxy layer when appropriate
- keep runtime SQLite and upload storage protected by filesystem permissions
- maintain current Node.js and npm dependencies
- back up runtime data securely

## Disclosure

Please allow reasonable time for the maintainer to investigate and address a reported vulnerability before public disclosure.
