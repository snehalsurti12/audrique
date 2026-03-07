# Security

Audrique is built with **enterprise-grade security** as a first-class concern. No credentials ever appear in code, logs, or test artifacts.

## Zero Trust Credential Management

```
┌──────────────────────────────────────────────────────────┐
│                  Secrets Architecture                      │
│                                                           │
│   Config File          Runtime Resolution                 │
│   ─────────           ──────────────────                  │
│   SF_PASSWORD_REF  ──→  Vault / Env / SOPS  ──→  Value   │
│   AWS_SECRET_REF   ──→  Never in plaintext   ──→  Value   │
│   CONNECT_TOKEN_REF──→  Never in logs        ──→  Value   │
│                                                           │
│   .auth/ directory: gitignored, session-only              │
│   Regulated mode: blocks plaintext in config              │
└──────────────────────────────────────────────────────────┘
```

| Security Layer | Implementation |
|----------------|----------------|
| **Secret references** | All credentials use `*_REF` suffix — resolved at runtime, never stored in plaintext |
| **HashiCorp Vault** | Native integration — `SECRETS_BACKEND=vault` with path-based secret resolution |
| **Environment isolation** | Secrets resolved from `$ENV_VAR` — compatible with CI/CD secret stores |
| **Regulated mode** | `REGULATED_MODE=true` blocks any plaintext secret in config files |
| **Session isolation** | `.auth/` directory is gitignored; browser sessions captured once, reused headlessly |
| **No credential logging** | Secret values are never written to console, test results, or video evidence |
| **Org-scoped profiles** | Each instance (`instances/myorg.env`) is isolated — no cross-org credential leakage |

## Configuration Examples

```bash
# Environment-backed secrets (CI/CD compatible)
SECRETS_BACKEND=env
SF_PASSWORD_REF=SF_PASSWORD_SECRET      # resolved from $SF_PASSWORD_SECRET
AWS_SECRET_REF=AWS_SECRET_ACCESS_KEY    # resolved from $AWS_SECRET_ACCESS_KEY

# HashiCorp Vault-backed secrets (enterprise)
SECRETS_BACKEND=vault
VAULT_ADDR=https://vault.internal:8200
SF_PASSWORD_REF=kv/data/voice/sf#password
AWS_SECRET_REF=kv/data/voice/aws#secret_key
```

## Compliance Considerations

- **SOC 2 / ISO 27001** — No secrets in source, audit trail via Vault
- **HIPAA / PCI** — Regulated mode prevents accidental plaintext exposure
- **GDPR** — Test data isolation per org, no PII in video evidence metadata
- **FedRAMP** — Vault-backed secrets with role-based access control
