Here's a dashboard JSON for a single cluster with multiple services. Replace the placeholders (`REGION`, `CLUSTER_NAME`, service names, log group names) before importing.

```json
{
  "widgets": [
    {
      "type": "text",
      "x": 0, "y": 0, "width": 24, "height": 2,
      "properties": {
        "markdown": "# ECS Downtime / Error Correlation — `CLUSTER_NAME`\nTop row: capacity & task health. Middle: resource pressure. Bottom: errors & stop reasons. All widgets share the dashboard time range — narrow it to a suspected incident window."
      }
    },

    {
      "type": "metric",
      "x": 0, "y": 2, "width": 12, "height": 6,
      "properties": {
        "title": "Running vs Desired Tasks (per service)",
        "view": "timeSeries",
        "stacked": false,
        "region": "REGION",
        "period": 60,
        "stat": "Average",
        "metrics": [
          [ "ECS/ContainerInsights", "RunningTaskCount", "ServiceName", "service-a", "ClusterName", "CLUSTER_NAME" ],
          [ "...", "service-b", ".", "." ],
          [ "...", "service-c", ".", "." ],
          [ "ECS/ContainerInsights", "DesiredTaskCount", "ServiceName", "service-a", "ClusterName", "CLUSTER_NAME", { "yAxis": "right" } ],
          [ "...", "service-b", ".", ".", { "yAxis": "right" } ],
          [ "...", "service-c", ".", ".", { "yAxis": "right" } ]
        ],
        "yAxis": {
          "left":  { "label": "Running", "min": 0 },
          "right": { "label": "Desired", "min": 0 }
        }
      }
    },

    {
      "type": "metric",
      "x": 12, "y": 2, "width": 12, "height": 6,
      "properties": {
        "title": "Container Instance Count (cluster capacity)",
        "view": "timeSeries",
        "region": "REGION",
        "period": 60,
        "stat": "Average",
        "metrics": [
          [ "ECS/ContainerInsights", "ContainerInstanceCount", "ClusterName", "CLUSTER_NAME" ],
          [ ".", "TaskCount", ".", "." ],
          [ ".", "PendingTaskCount", ".", "." ]
        ],
        "annotations": {
          "horizontal": [ { "label": "Investigate drops", "value": 0 } ]
        }
      }
    },

    {
      "type": "metric",
      "x": 0, "y": 8, "width": 8, "height": 6,
      "properties": {
        "title": "CPU Utilization (per service, p95)",
        "view": "timeSeries",
        "region": "REGION",
        "period": 60,
        "stat": "p95",
        "metrics": [
          [ "ECS/ContainerInsights", "CpuUtilized", "ServiceName", "service-a", "ClusterName", "CLUSTER_NAME" ],
          [ "...", "service-b", ".", "." ],
          [ "...", "service-c", ".", "." ]
        ],
        "yAxis": { "left": { "label": "vCPU units", "min": 0 } }
      }
    },

    {
      "type": "metric",
      "x": 8, "y": 8, "width": 8, "height": 6,
      "properties": {
        "title": "Memory Utilization (per service, p95)",
        "view": "timeSeries",
        "region": "REGION",
        "period": 60,
        "stat": "p95",
        "metrics": [
          [ "ECS/ContainerInsights", "MemoryUtilized", "ServiceName", "service-a", "ClusterName", "CLUSTER_NAME" ],
          [ "...", "service-b", ".", "." ],
          [ "...", "service-c", ".", "." ]
        ],
        "yAxis": { "left": { "label": "MiB", "min": 0 } }
      }
    },

    {
      "type": "metric",
      "x": 16, "y": 8, "width": 8, "height": 6,
      "properties": {
        "title": "Container Instance Pressure (max across cluster)",
        "view": "timeSeries",
        "region": "REGION",
        "period": 60,
        "stat": "Maximum",
        "metrics": [
          [ "ECS/ContainerInsights", "CpuReserved", "ClusterName", "CLUSTER_NAME" ],
          [ ".", "MemoryReserved", ".", "." ]
        ]
      }
    },

    {
      "type": "log",
      "x": 0, "y": 14, "width": 12, "height": 7,
      "properties": {
        "title": "Application Error Rate (per minute)",
        "region": "REGION",
        "view": "timeSeries",
        "stacked": false,
        "query": "SOURCE 'APP_LOG_GROUP'\n| fields @timestamp, @logStream, @message\n| filter @message like /(?i)error|exception|fatal|panic|timeout|refused|5\\d\\d/\n| stats count() as errors by bin(1m), @logStream"
      }
    },

    {
      "type": "log",
      "x": 12, "y": 14, "width": 12, "height": 7,
      "properties": {
        "title": "Task Stop Reasons (from ECS EventBridge → CW Logs)",
        "region": "REGION",
        "view": "table",
        "query": "SOURCE 'ECS_EVENTS_LOG_GROUP'\n| fields @timestamp, detail.stopCode as stopCode, detail.stoppedReason as reason, detail.taskArn as task, detail.containerInstanceArn as instance\n| filter `detail-type` = \"ECS Task State Change\"\n| filter detail.lastStatus = \"STOPPED\"\n| filter stopCode in [\"TaskFailedToStart\", \"EssentialContainerExited\", \"ServiceSchedulerInitiated\", \"UserInitiated\"]\n| sort @timestamp desc\n| limit 50"
      }
    },

    {
      "type": "log",
      "x": 0, "y": 21, "width": 12, "height": 6,
      "properties": {
        "title": "Container Instance State Changes (agent disconnects / draining)",
        "region": "REGION",
        "view": "table",
        "query": "SOURCE 'ECS_EVENTS_LOG_GROUP'\n| fields @timestamp, detail.containerInstanceArn as instance, detail.status as status, detail.agentConnected as agent, detail.statusReason as reason\n| filter `detail-type` = \"ECS Container Instance State Change\"\n| filter status in [\"DRAINING\", \"INACTIVE\"] or detail.agentConnected = false\n| sort @timestamp desc\n| limit 50"
      }
    },

    {
      "type": "log",
      "x": 12, "y": 21, "width": 12, "height": 6,
      "properties": {
        "title": "Top Error Messages (grouped)",
        "region": "REGION",
        "view": "table",
        "query": "SOURCE 'APP_LOG_GROUP'\n| fields @timestamp, @message\n| filter @message like /(?i)error|exception|fatal|panic/\n| parse @message /(?<level>ERROR|FATAL|EXCEPTION|PANIC)[^a-zA-Z](?<snippet>[^\\n]{0,120})/\n| stats count() as occurrences by level, snippet\n| sort occurrences desc\n| limit 20"
      }
    }
  ]
}
```

### Things to swap

- `REGION` → e.g. `us-east-1`
- `CLUSTER_NAME` → your cluster
- `service-a/b/c` → real service names (add or remove metric rows to match)
- `APP_LOG_GROUP` → the log group containing your app's error stream
- `ECS_EVENTS_LOG_GROUP` → the log group receiving ECS events from EventBridge (if you haven't set this up: EventBridge rule on source `aws.ecs`, target a CloudWatch Logs group)

### To import

Save as `dashboard.json`, then:

```bash
aws cloudwatch put-dashboard \
  --dashboard-name ecs-downtime-correlation \
  --dashboard-body file://dashboard.json
```

Or paste into the CloudWatch console → Dashboards → Actions → View/edit source.

### Reading it

When a node goes down, you'll see the top row drop (running tasks, instance count), the middle row often spikes just before (memory/CPU pressure causing OOM kills), and the bottom-left chart will show the error spike in the app stream at the same timestamp. The stop-reason table tells you whether it was `EssentialContainerExited` (app crash), `TaskFailedToStart` (infra problem), or scheduler/user-initiated (deploy or drain).

If your EventBridge → CW Logs pipe isn't set up yet, the two bottom-row event widgets will be empty — let me know and I can give you the EventBridge rule JSON too.
