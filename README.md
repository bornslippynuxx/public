demo


```bash
DEPLOYMENT_ID="$1"
SLEEP_TIME="${2:-10}"

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Error: Must provide Blue/Green deployment ID as first argument"
  exit 1
fi

echo "Starting Blue/Green switchover for deployment: $DEPLOYMENT_ID"

# Perform the switchover
aws rds switchover-blue-green-deployment --blue-green-deployment-identifier "$DEPLOYMENT_ID" > /dev/null

if [[ $? -ne 0 ]]; then
  echo "Failed to initiate switchover"
  exit 1
fi

echo "Monitoring switchover progress..."

while true; do
  STATUS=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$DEPLOYMENT_ID" \
    --query 'BlueGreenDeployment.Status' --output text)
  
  if [[ "$STATUS" == "switched" ]]; then
    echo "Switchover completed successfully!"
    exit 0
  elif [[ "$STATUS" == "failed" ]]; then
    echo "Switchover failed!"
    exit 1
  elif [[ "$STATUS" != "switching" ]]; then
    echo "Unexpected status: $STATUS (expected switching/switched/failed)"
    exit 1
  fi
  
  echo "Current status: $STATUS... Sleeping $SLEEP_TIME seconds"
  sleep "$SLEEP_TIME"
done
```
