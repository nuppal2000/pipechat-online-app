# Supabase Database CA

This is a public certificate, not a secret or a private key. It is used only by the opt-in database restore runner. It is not installed in Windows, the browser, or the production app's global trust store.

Source: the source project's Database Settings > SSL configuration > Download certificate link, observed on 2026-09-22:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Retrieved over normally verified HTTPS. Subject: Supabase Root 2021 CA. Valid through 2031-04-26. SHA-256 certificate fingerprint:

`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`

The runner checks the fingerprint, CA flag, self-signature and validity dates. Both node-postgres and the portable PostgreSQL tools use the same CA bundle. Certificate chain and hostname verification remain enabled. Review a future CA rotation against the official dashboard; do not accept an arbitrary peer certificate or disable TLS verification.

Reference: https://supabase.com/docs/guides/platform/ssl-enforcement
