#!/usr/bin/env bash
# Keep complete reports, including unfixed issues; only fixable HIGH/CRITICAL
# vulnerabilities block CI. Run both requested images even if the first gate fails.
set -euo pipefail
mkdir -p tmp/security
case "${1:-all}" in
  all) images=('studio shadergrove:security' 'website shadergrove-website:security') ;;
  studio) images=('studio shadergrove:security') ;;
  website) images=('website shadergrove-website:security') ;;
  *) echo "Unknown image scope: $1" >&2; exit 2 ;;
esac
status=0
for entry in "${images[@]}"; do
  read -r name image <<< "$entry"
  trivy image --scanners vuln --format cyclonedx --output "tmp/security/$name-image.cdx.json" "$image"
  trivy image --scanners vuln --format json --output "tmp/security/$name-vulnerabilities.json" "$image"
  trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "$image" || status=1
done
exit "$status"
