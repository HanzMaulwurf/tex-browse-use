# Security

This document describes the security model of the **TEX browse-use** bundle, what this published package does and does not contain, and the steps you should take before and while running it.

TEX drives a **real browser** to operate web apps on your behalf. That means it can log in, click, type, and read pages exactly like a human would. Treat it accordingly: it is a powerful local agent, not a sandboxed toy. The notes below are crisp and actionable — read them before you point it at anything sensitive.

---

## 1. This bundle ships a clean git history

This published package was created with a **clean git history**. There are no committed secrets, no logged-in browser sessions, and no customer data baked into the repository.

- The runtime data directory **`stack/data/`** is **gitignored**. Everything the engine writes at runtime (vault, sessions, learned skills, audit material) lives there and never enters version control.
- The finance-specific code and a company's private data that existed in the internal version were **removed** before publishing. What you get is the generalized browse-use feature.
- Your `.env` is also **gitignored** — only `.env.example` (a template with no real keys) is tracked.

In short: nothing in this repo as published is a secret. The sensitive stuff is meant to be generated locally and stay local.

---

## 2. The credential vault

TEX can store per-app logins so it can re-authenticate without you re-typing them.

- Credentials are stored **AES-256-GCM encrypted** in **`stack/data/vault/`** (gitignored — never committed).
- Encryption is keyed by the **`ENCRYPTION_KEY`** environment variable. If you use the vault, **set a stable `ENCRYPTION_KEY`** in your `.env`. If the key changes (or is unset and falls back), previously encrypted entries become unreadable. Keep this key out of version control and back it up somewhere safe — it is the only thing protecting the vault contents at rest.

### Important: credentials transit to your LLM provider

At run time, stored login credentials are **injected into the LLM prompt** so the agent can fill in login forms. This means those credentials **leave your machine and are sent to whichever LLM provider you configured** (Anthropic direct API, or AWS Bedrock).

Practical consequence:

> **Only store credentials for apps you are comfortable sending to your chosen LLM provider.**

- If you have a data-residency / DSGVO requirement, prefer the **Bedrock** provider with an EU region (`AWS_REGION` + `BEDROCK_MODEL=eu.anthropic.claude-sonnet-4-6`) so the prompt traffic stays in your chosen region.
- For anything you would not be willing to hand to a third-party model API, do **not** put it in the vault.

---

## 3. The engine exposes an unauthenticated local API

The engine is a Node/Hono HTTP server. Its API is **unauthenticated** — there is no token, no auth header, no login on the engine itself.

- It is intended to bind to **`127.0.0.1`** only (default `http://127.0.0.1:18802`, `TEX_ENGINE_URL`). Anyone who can reach that port can issue browse-use tasks and read responses, with no credentials required.
- **Keep it bound to localhost. Do not expose the port publicly**, and do not put it behind a port-forward, reverse proxy, or `0.0.0.0` bind without adding your own authentication and network controls in front of it.
- The same applies to the optional Linux-side services in the full stack (stealth `:18803`, gateway `:18804`, a11y `:18805`). They are local helpers, not public endpoints.

If you genuinely need remote access, terminate it behind your own authenticated proxy on a trusted network — never hang the raw engine port on the open internet.

---

## 4. If you forked this from an internal / private repo

This published bundle deliberately **does not** carry the original upstream history. But if you obtained TEX from the **original internal/private repository** (not this clean publish), be aware:

- That original history **may have contained real secrets** — for example a **logged-in browser profile**, **plaintext app credentials**, and **business data** — committed at some point in the past.

If you have access to that original repo, do the following:

1. **Rotate** any credential that was ever committed (app logins, API keys, session tokens) — assume they are compromised.
2. **Scrub the history** (e.g. with a history-rewrite tool) and force-push, or re-publish from a clean export, so the secrets are no longer retrievable from any clone.
3. Going forward, keep secrets in `.env` and the encrypted vault under `stack/data/` (both gitignored) — never commit them.

This clean bundle exists precisely so you can publish/share TEX without dragging that history along.

---

## Quick checklist

- [ ] `.env` is present locally and **not** committed (it's gitignored).
- [ ] `ENCRYPTION_KEY` is set and stable if you use the vault; backed up out-of-band.
- [ ] You're comfortable that any vault-stored logins will be sent to your LLM provider in the prompt.
- [ ] Engine port (`:18802`) is bound to `127.0.0.1` and not exposed publicly.
- [ ] If you came from the internal repo: rotated leaked credentials and scrubbed the old history.
