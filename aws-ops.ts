import {
  ECSClient,
  RunTaskCommand,
  UpdateServiceCommand,
  DescribeTasksCommand,
  waitUntilTasksStopped,
  waitUntilServicesStable,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  RDSClient,
  CreateDBSnapshotCommand,
  waitUntilDBSnapshotAvailable,
} from "@aws-sdk/client-rds";
import {
  DescribeServicesCommand,
} from "@aws-sdk/client-ecs";
import type { AirflowConfig } from "../../lib/config";

export class AwsOps {
  private ecs: ECSClient;
  private ssm: SSMClient;
  private rds: RDSClient;

  constructor(private cfg: AirflowConfig) {
    this.ecs = new ECSClient({ region: cfg.region });
    this.ssm = new SSMClient({ region: cfg.region });
    this.rds = new RDSClient({ region: cfg.region });
  }

  // ---- RDS snapshot: the rollback point for the downtime path ----

  /**
   * Create an RDS snapshot and block until it is `available`. Returns the
   * snapshot identifier so it can be logged for the rollback runbook.
   * MUST complete before any migrate begins on the non-compat path.
   */
  async snapshotDb(opts: {
    dbInstanceIdentifier: string;
    label: string; // e.g. "pre-upgrade-3-0-2"
    timeoutSec?: number;
  }): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const snapshotId = `${opts.dbInstanceIdentifier}-${opts.label}-${ts}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 255);

    await this.rds.send(
      new CreateDBSnapshotCommand({
        DBInstanceIdentifier: opts.dbInstanceIdentifier,
        DBSnapshotIdentifier: snapshotId,
      }),
    );
    await waitUntilDBSnapshotAvailable(
      { client: this.rds, maxWaitTime: opts.timeoutSec ?? 3600 },
      { DBSnapshotIdentifier: snapshotId },
    );
    return snapshotId;
  }

  // ---- ECS scaling: capture-then-restore for the quiesce window ----

  /** Read the current desiredCount of each service so it can be restored. */
  async getDesiredCounts(services: string[]): Promise<Record<string, number>> {
    const res = await this.ecs.send(
      new DescribeServicesCommand({
        cluster: this.cfg.clusterName,
        services,
      }),
    );
    const out: Record<string, number> = {};
    for (const s of res.services ?? []) {
      if (s.serviceName) out[s.serviceName] = s.desiredCount ?? 0;
    }
    return out;
  }

  /** Set desiredCount and wait for the service to settle at that count. */
  async scaleService(opts: {
    service: string;
    desiredCount: number;
    timeoutSec?: number;
  }): Promise<void> {
    await this.ecs.send(
      new UpdateServiceCommand({
        cluster: this.cfg.clusterName,
        service: opts.service,
        desiredCount: opts.desiredCount,
      }),
    );
    await waitUntilServicesStable(
      { client: this.ecs, maxWaitTime: opts.timeoutSec ?? 600 },
      { cluster: this.cfg.clusterName, services: [opts.service] },
    );
  }

  // ---- SSM: the desired image tag lives here, not in code ----

  async getImageTag(): Promise<string> {
    const res = await this.ssm.send(
      new GetParameterCommand({ Name: this.cfg.imageTagParam }),
    );
    const tag = res.Parameter?.Value;
    if (!tag) throw new Error(`SSM param ${this.cfg.imageTagParam} is empty`);
    return tag;
  }

  /**
   * Run a one-off Fargate task with a command override, then block until it
   * stops. Returns the container exit code. This replaces a bash script that
   * fires a task and polls with `sleep` in a loop.
   */
  async runOneOffTask(opts: {
    imageTag: string;
    command: string[];
    /** Extra env vars layered onto the task def's container. */
    env?: Record<string, string>;
    timeoutSec?: number;
  }): Promise<{ exitCode: number; task: Task }> {
    const run = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.cfg.clusterName,
        taskDefinition: this.cfg.maintenanceTaskFamily, // latest ACTIVE revision
        launchType: "FARGATE",
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.cfg.network.subnetIds,
            securityGroups: this.cfg.network.securityGroupIds,
            assignPublicIp: this.cfg.network.assignPublicIp ? "ENABLED" : "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.cfg.maintenanceContainerName,
              command: opts.command,
              // Pin the image tag for this run via env the entrypoint reads,
              // OR register a fresh task def revision if you override image.
              // (ECS RunTask cannot override the image directly.)
              environment: Object.entries(opts.env ?? {}).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ],
        },
      }),
    );

    const taskArn = run.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const reason = run.failures?.[0]?.reason ?? "unknown";
      throw new Error(`RunTask did not start a task: ${reason}`);
    }

    await waitUntilTasksStopped(
      { client: this.ecs, maxWaitTime: opts.timeoutSec ?? 1800 },
      { cluster: this.cfg.clusterName, tasks: [taskArn] },
    );

    const desc = await this.ecs.send(
      new DescribeTasksCommand({ cluster: this.cfg.clusterName, tasks: [taskArn] }),
    );
    const task = desc.tasks?.[0];
    const container = task?.containers?.find(
      (c) => c.name === this.cfg.maintenanceContainerName,
    );
    const exitCode = container?.exitCode ?? -1;
    return { exitCode, task: task! };
  }

  /**
   * Point a service at a new task definition and wait for it to reach a
   * stable state (deployment complete, healthy, old tasks drained).
   */
  async updateServiceTaskDef(opts: {
    service: string;
    taskDefinition: string; // family:revision or full ARN
    timeoutSec?: number;
  }): Promise<void> {
    await this.ecs.send(
      new UpdateServiceCommand({
        cluster: this.cfg.clusterName,
        service: opts.service,
        taskDefinition: opts.taskDefinition,
        forceNewDeployment: true,
      }),
    );

    await waitUntilServicesStable(
      { client: this.ecs, maxWaitTime: opts.timeoutSec ?? 1200 },
      { cluster: this.cfg.clusterName, services: [opts.service] },
    );
  }
}
