Replace src/server.js and package.json in the existing project, then rebuild:

oc start-build torn-calls -n discord-dev --from-dir=. --follow
oc rollout restart deployment/torn-calls -n discord-dev
oc rollout status deployment/torn-calls -n discord-dev --timeout=120s
oc logs deployment/torn-calls -n discord-dev --tail=100

Expected log:
Torn Calls API v2 listening on port 3000

Validate:
chmod +x scripts/validate.sh
export API_TOKEN='the token stored in the OpenShift secret'
./scripts/validate.sh
