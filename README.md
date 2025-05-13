demo

## switch

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

## create

```bash
#!/bin/bash

# Usage: ./create_blue_green.sh </deployment-id>   [wait]
# Example: ./create_blue_green.sh my-db-deployment source-db-instance target-db-instance
# Optional wait flag (default: no wait, just returns after creation)

DEPLOYMENT_ID="$1"
SOURCE_DB="$2"
TARGET_DB="$3"
WAIT="${4:-false}"
SLEEP_TIME=10

if [[ -z "$DEPLOYMENT_ID" || -z "$SOURCE_DB" || -z "$TARGET_DB" ]]; then
  echo "Error: Must provide Deployment ID, Source DB, and Target DB as arguments"
  exit 1
fi

echo "Creating Blue/Green deployment: $DEPLOYMENT_ID"

aws rds create-blue-green-deployment \
  --blue-green-deployment-identifier "$DEPLOYMENT_ID" \
  --source-db-instance-identifier "$SOURCE_DB" \
  --target-db-instance-identifier "$TARGET_DB"

if [[ $? -ne 0 ]]; then
  echo "Deployment creation failed"
  exit 1
fi

echo "Deployment created successfully"

if [[ "$WAIT" == "true" ]]; then
  echo "Monitoring deployment status until ready..."
  while true; do
    STATUS=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$DEPLOYMENT_ID" \
      --query 'BlueGreenDeployment.Status' --output text)
    
    case "$STATUS" in
      "ready")
        echo "Deployment is now ready to switch"
        exit 0
        ;;
      "creating")
        echo "Deployment still creating... Sleeping $SLEEP_TIME seconds"
        sleep "$SLEEP_TIME"
        ;;
      "failed")
        echo "Deployment creation failed permanently"
        exit 1
        ;;
      *)
        echo "Unexpected status: $STATUS (expected creating/ready/failed)"
        exit 1
        ;;
    esac
  done
fi

exit 0
```

## delete

```bash
#!/bin/bash

# Usage: ./delete_blue_green.sh  [poll-interval]
# Example: ./delete_blue_green.sh my-db-deployment 10

DEPLOYMENT_ID="$1"
SLEEP_TIME="${2:-10}"

if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Error: Must provide Blue/Green deployment ID"
  exit 1
fi

echo "Initiating deletion of deployment: $DEPLOYMENT_ID"

# Attempt to delete
aws rds delete-blue-green-deployment --blue-green-deployment-identifier "$DEPLOYMENT_ID" > /dev/null

if [[ $? -ne 0 ]]; then
  echo "Failed to initiate deletion"
  exit 1
fi

echo "Monitoring deletion progress..."

while true; do
  # Check if deployment still exists
  if ! aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$DEPLOYMENT_ID" > /dev/null 2>&1; then
    echo "Deployment deleted successfully!"
    exit 0
  fi

  STATUS=$(aws rds describe-blue-green-deployments --blue-green-deployment-identifier "$DEPLOYMENT_ID" \
    --query 'BlueGreenDeployment.Status' --output text)
  
  case "$STATUS" in
    "deleting")
      echo "Current status: $STATUS... Sleeping $SLEEP_TIME seconds"
      sleep "$SLEEP_TIME"
      ;;
    "deleted")
      echo "Deployment deleted successfully!"
      exit 0
      ;;
    "failed")
      echo "Deletion failed!"
      exit 1
      ;;
    *)
      echo "Unexpected status: $STATUS (expected deleting/deleted/failed)"
      exit 1
      ;;
  esac
done
```
