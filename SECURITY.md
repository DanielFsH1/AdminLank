# Security Policy

Report exposed credentials privately to the repository owner. Do not open public issues containing secrets, personal data, tokens, passwords, account identifiers, CLABEs, card data, or Firebase exports.

The repository is expected to pass secret scanning before being made public. Values needed for local operation belong in `.env.local`, Firebase/GCP runtime configuration, or ignored local files.

Before pushing changes, run:

```bash
gitleaks dir . --redact
gitleaks git . --redact --log-opts="--all"
detect-secrets scan . --exclude-files '^dashboard/package-lock\.json$' --exclude-lines 'example|placeholder|test|dummy|fake|isPasswordShared|updates\.password|secretDocId|linked vault secret|microsoft365'
```
