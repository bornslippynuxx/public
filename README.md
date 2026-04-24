

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

```
#!/usr/bin/env bash
set -euo pipefail

# Point a stable hostname at a given target group on a listener.
# - If a rule for $stable_host already exists on the listener, modifies its action.
# - If not, creates a new rule at $priority.
#
# Usage:
#   route_stable_host <listener_arn> <stable_host> <target_tg_arn> [priority]
route_stable_host() {
  local listener_arn="$1"
  local stable_host="$2"
  local target_tg_arn="$3"
  local priority="${4:-50}"  # only used on initial create

  # Look for an existing rule on this listener whose host-header matches stable_host.
  # Match against both legacy Values and HostHeaderConfig.Values to be safe.
  local existing_rule_arn
  existing_rule_arn=$(aws elbv2 describe-rules \
    --listener-arn "$listener_arn" \
    --query "Rules[?Conditions[?Field=='host-header' && (contains(Values, '$stable_host') || contains(HostHeaderConfig.Values, '$stable_host'))]].RuleArn | [0]" \
    --output text)

  if [[ -n "$existing_rule_arn" && "$existing_rule_arn" != "None" ]]; then
    aws elbv2 modify-rule \
      --rule-arn "$existing_rule_arn" \
      --actions "Type=forward,TargetGroupArn=$target_tg_arn" \
      >/dev/null
    echo "Repointed $stable_host -> $target_tg_arn (rule: $existing_rule_arn)" >&2
    echo "$existing_rule_arn"
  else
    local new_rule_arn
    new_rule_arn=$(aws elbv2 create-rule \
      --listener-arn "$listener_arn" \
      --priority "$priority" \
      --conditions "Field=host-header,Values=$stable_host" \
      --actions "Type=forward,TargetGroupArn=$target_tg_arn" \
      --query 'Rules[0].RuleArn' \
      --output text)
    echo "Created rule for $stable_host -> $target_tg_arn (rule: $new_rule_arn)" >&2
    echo "$new_rule_arn"
  fi
}
```
