CloudWatch Logs Insights can't directly join a metric (task count) against a log query — they're separate systems. But there are two clean ways to do the comparison:

## Option A: Both as logs (easiest, single Insights query)

If you have Container Insights enabled, task counts are *also* written as logs to `/aws/ecs/containerinsights/<cluster>/performance`. So you can query both log groups together.

In the Logs Insights console, select **both** log groups (your app log group + the performance log group), then:

```
fields @timestamp, @log, @message
| filter (Type = "Service" and ServiceName = "your-service-name")
       or @message like /YourSpecificErrorMessage/
| stats avg(RunningTaskCount) as running_tasks,
        sum(strcontains(@message, "YourSpecificErrorMessage")) as error_count
        by bin(1m)
| sort @timestamp asc
```

How it works: the performance log group emits a record per service per minute containing `RunningTaskCount`; your app log group emits error lines. Bucketing both by `bin(1m)` and aggregating gives you one row per minute with both numbers side by side — ready to eyeball or chart.

For an exact string match instead of regex, swap the filter to `@message = "YourSpecificErrorMessage"` and adjust the `strcontains` accordingly.

## Option B: Metrics Insights + a metric filter (better for dashboards/alarms)

Turn the error message into a CloudWatch metric first, then graph both metrics together.

**Step 1** — create a metric filter on the app log group:

```bash
aws logs put-metric-filter \
  --log-group-name /your/app/log-group \
  --filter-name SpecificErrorCount \
  --filter-pattern '"YourSpecificErrorMessage"' \
  --metric-transformations \
      metricName=SpecificErrorCount,metricNamespace=AppErrors,metricValue=1,defaultValue=0
```

**Step 2** — Metrics Insights query (works in dashboard widgets, alarms, `get-metric-data`):

```sql
SELECT SUM(SpecificErrorCount)
FROM "AppErrors"
```

paired with

```sql
SELECT AVG(RunningTaskCount)
FROM SCHEMA("ECS/ContainerInsights", ClusterName, ServiceName)
WHERE ClusterName = 'your-cluster' AND ServiceName = 'your-service'
```

Drop both into the same graph widget — left axis errors, right axis task count. The visual correlation is immediate, and you can alarm on either.

## Which to use

Option A is good for one-off investigations: paste, run, read. Option B is what you want if this is going to live on a dashboard or trigger alerts, because metric filters retain data for 15 months versus Logs Insights' query-time-only computation, and you can alarm on the metric directly.

One gotcha worth flagging: a metric filter only counts log events that arrive *after* it's created — it won't backfill. If you need historical correlation, run Option A first to confirm the pattern, then put the filter in place for ongoing monitoring.
