#!/usr/bin/env bash
# Keep complete reports, including unfixed issues; only fixable HIGH/CRITICAL
# vulnerabilities block CI. Run both images even when the first gate fails.
set -euo pipefail
mkdir -p tmp/security
status=0
for entry in 'studio shadergrove:security' 'website shadergrove-website:security'; do
  read -r name image <<< "$entry"
  trivy image --scanners vuln --format cyclonedx --output "tmp/security/$name-image.cdx.json" "$image"
  trivy image --scanners vuln --format json --output "tmp/security/$name-vulnerabilities.json" "$image"
  trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "$image" || status=1
done
exit "$status"
