# Security

## Reporting a vulnerability

If you find a security issue, please **do not** open a public issue. Email the maintainers or open a private security advisory on GitHub so we can address it before disclosure.

## What we do

- **No storage of Tesla passwords** — Users sign in via Tesla’s OAuth; we never see or store passwords.
- **PKCE** — Authorization code flow uses PKCE (code_verifier / code_challenge).
- **State parameter** — OAuth state is used to mitigate CSRF.
- **Session-only credentials** — In HTTP mode, Client ID/Secret and tokens are kept in server memory per session and are not written to disk.
- **No sensitive logging** — We do not log tokens, full session IDs, or API response bodies that could contain secrets.
- **Secrets check** — Run `./check-secrets.sh` before committing to catch accidental hardcoded secrets.

## What you must do

- **Never commit** `.env`, `keys/`, or any file containing tokens or private keys. `.gitignore` is set up for this; verify before pushing.
- **Use HTTPS in production** — Tesla OAuth requires HTTPS for redirect URIs. Do not use the HTTP server over plain HTTP in production.
- **Set BASE_URL** — When hosting the HTTP server, set `BASE_URL` to your public HTTPS URL so OAuth redirects work and users are not sent to the wrong host.
- **Run the secrets checker** — Before each push, run `./check-secrets.sh` (or add it to CI).
- **Restrict CORS** (optional) — For production you can narrow CORS in the HTTP server to your known client origins instead of allowing all.

## Data we handle

- **HTTP mode:** We store in memory per session: Tesla Client ID, Client Secret, access token, refresh token, and PKCE state. Sessions expire; we do not persist these to disk or a database.
- **Stdio mode:** Credentials are read from the environment (e.g. `.env`) on the machine where the server runs; we do not transmit them to third parties.

We do not collect analytics or send your data to our own servers.
