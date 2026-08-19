---
gcp: true
---
### GCP

Credentials are pre-configured in `CLOUDSDK_CONFIG`, so `gcloud` commands work
directly. Terraform and other Google client libraries authenticate via
`GOOGLE_OAUTH_ACCESS_TOKEN`. The token expires after 1 hour. If a command
fails, check if the token has expired and ask for a new one.
