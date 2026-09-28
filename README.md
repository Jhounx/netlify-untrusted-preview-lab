# Netlify untrusted preview boundary lab

Public, controlled fixture for validating Netlify Deploy Preview trust boundaries.

- Contains no customer data or production credentials.
- Uses only synthetic canaries.
- Security probes must never print or publish raw tokens or secret values.
- Every one-shot probe must be removed after evidence capture.
