

```
#!/usr/bin/env bash
set -euo pipefail

VERSION="$1"
STACK_NAME="AirflowStack-${VERSION}"

# Check if the stack already exists
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" &>/dev/null; then
  echo "Stack exists — deploying update (preserving desired count)"
  INITIAL_DEPLOY="false"
else
  echo "First deploy — setting desired count to 0"
  INITIAL_DEPLOY="true"
fi

cdk deploy "$STACK_NAME" \
  --context version="$VERSION" \
  --context initialDeploy="$INITIAL_DEPLOY"
```
