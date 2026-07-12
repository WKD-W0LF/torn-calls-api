#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-discord-dev}"
BASE_URL="${BASE_URL:-https://torn-calls.apps.gpu4.fusion.isys.hpc.dc.uq.edu.au}"
API_TOKEN="${API_TOKEN:-}"
TARGET_ID="999000111"

if [[ -z "${API_TOKEN}" ]]; then
  echo "Set API_TOKEN before running."
  exit 1
fi

oc rollout status deployment/torn-calls -n "${NAMESPACE}" --timeout=120s
curl --fail --silent --show-error "${BASE_URL}/health"; echo
curl --fail --silent --show-error "${BASE_URL}/ready"; echo

curl --silent -X DELETE "${BASE_URL}/api/v1/calls/${TARGET_ID}" -H "Authorization: Bearer ${API_TOKEN}" >/dev/null || true

CREATE_RESPONSE="$(curl --fail --silent --show-error -X POST "${BASE_URL}/api/v1/calls" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"targetId":"999000111","targetName":"API-Test-Target","calledById":"999000222","calledByName":"API-Test-Caller"}')"
echo "${CREATE_RESPONSE}"
echo "${CREATE_RESPONSE}" | grep -q '"priority":false'
echo "${CREATE_RESPONSE}" | grep -q '"assistRequested":false'

PATCH_RESPONSE="$(curl --fail --silent --show-error -X PATCH "${BASE_URL}/api/v1/calls/${TARGET_ID}" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"priority":true,"assistRequested":true}')"
echo "${PATCH_RESPONSE}"
echo "${PATCH_RESPONSE}" | grep -q '"priority":true'
echo "${PATCH_RESPONSE}" | grep -q '"assistRequested":true'

LIST_RESPONSE="$(curl --fail --silent --show-error -H "Authorization: Bearer ${API_TOKEN}" "${BASE_URL}/api/v1/calls")"
echo "${LIST_RESPONSE}"
echo "${LIST_RESPONSE}" | grep -q '"targetId":"999000111"'
echo "${LIST_RESPONSE}" | grep -q '"priority":true'
echo "${LIST_RESPONSE}" | grep -q '"assistRequested":true'

curl --fail --silent --show-error -X DELETE "${BASE_URL}/api/v1/calls/${TARGET_ID}" -H "Authorization: Bearer ${API_TOKEN}"; echo

echo "All Torn Calls API v2 validation checks passed."
