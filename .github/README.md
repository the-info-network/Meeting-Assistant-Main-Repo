# GitHub scripts and tools

## TruffleHog (secrets scanner)

TruffleHog is installed **inside this repo** under `.github/tools/` (the binary is gitignored).

**Install (from repo root):**
```bash
./.github/scripts/install-trufflehog.sh
```

**Run:**
```bash
# Scan this repo
./.github/tools/bin/trufflehog git file://$(pwd) --only-verified

# Scan GitHub org (requires GITHUB_TOKEN)
GITHUB_TOKEN=ghp_xxx ./.github/tools/bin/trufflehog github --org=tindevelopers --results=verified
```

Or use the wrapper script that scans all org repos:
```bash
GITHUB_TOKEN=ghp_xxx ./recall/scripts/trufflehog-scan-github.sh
```

Optional: pin a version:
```bash
TRUFFLEHOG_VERSION=v3.93.7 ./.github/scripts/install-trufflehog.sh
```
