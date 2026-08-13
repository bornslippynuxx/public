/**
 * Airflow 3.2 on Fargate — security groups.
 *
 * Egress is unrestricted everywhere: this VPC has no NAT gateway, so route
 * tables already prevent tasks from reaching the internet. SG egress rules
 * would only duplicate that. Revisit if a NAT is ever added.
 *
 * The one boundary that matters: workers cannot reach the metadata database.
 * In Airflow 3 they go through the Task Execution API instead. That is why
 * `worker` is absent from DB_CLIENTS below — if you ever add it there, you
 * have removed the boundary.
 */

import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface AirflowSecurityGroupsProps {
  readonly vpc: ec2.IVpc;
  readonly envName: string;

  /** Who can reach the UI. e.g. ec2.Peer.prefixList(corpLaptops.ref) */
  readonly uiClients: ec2.IPeer;

  /** Where Prometheus scrapes from. Omit if you don't scrape. */
  readonly prometheus?: ec2.IPeer;
}

const PORT = {
  https: ec2.Port.tcp(443),
  api: ec2.Port.tcp(8080),
  postgres: ec2.Port.tcp(5432),
  redis: ec2.Port.tcp(6379),
  metrics: ec2.Port.tcp(9102),
};

export class AirflowSecurityGroups extends Construct {
  /** Public ALB in front of the UI. */
  readonly alb: ec2.SecurityGroup;
  /** api-server: serves the UI and the Task Execution API. */
  readonly api: ec2.SecurityGroup;
  /** scheduler, dag-processor, triggerer, and one-shot ops tasks. */
  readonly control: ec2.SecurityGroup;
  /** celery workers — run DAG code, no database access. */
  readonly worker: ec2.SecurityGroup;
  readonly rds: ec2.SecurityGroup;
  readonly redis: ec2.SecurityGroup;
  /** Interface endpoints. With no NAT this is the only path to AWS APIs. */
  readonly vpce: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AirflowSecurityGroupsProps) {
    super(scope, id);

    const sg = (name: string, description: string) =>
      new ec2.SecurityGroup(this, name, {
        vpc: props.vpc,
        description: `${props.envName} airflow — ${description}`,
        allowAllOutbound: true, // see header
      });

    this.alb = sg('Alb', 'public ALB');
    this.api = sg('Api', 'api-server');
    this.control = sg('Control', 'scheduler, dag-processor, triggerer, ops');
    this.worker = sg('Worker', 'celery workers');
    this.rds = sg('Rds', 'metadata database');
    this.redis = sg('Redis', 'celery broker');
    this.vpce = sg('Vpce', 'interface VPC endpoints');

    const APP = [this.api, this.control, this.worker];
    const DB_CLIENTS = [this.api, this.control]; // deliberately not worker

    const allow = (
      target: ec2.SecurityGroup,
      source: ec2.IPeer,
      port: ec2.Port,
      why: string,
    ) => target.addIngressRule(source, port, why);

    // UI
    allow(this.alb, props.uiClients, PORT.https, 'operators -> UI');
    allow(this.api, this.alb, PORT.api, 'ALB -> api-server');

    // Task Execution API (workers reach the api-server via Cloud Map)
    allow(this.api, this.worker, PORT.api, 'worker -> execution API');
    allow(this.api, this.control, PORT.api, 'control plane -> execution API');

    // Metadata database
    for (const c of DB_CLIENTS) {
      allow(this.rds, c, PORT.postgres, 'control plane -> metadata DB');
    }

    // Broker. Requires [celery] result_backend on redis, NOT db+postgresql://,
    // or workers would need the database and the boundary above is void.
    for (const c of [this.control, this.worker]) {
      allow(this.redis, c, PORT.redis, 'celery broker');
    }

    // AWS APIs: ECR, Logs, Secrets Manager, SSM, STS, KMS.
    // S3 is a gateway endpoint — no SG. Restrict it with an endpoint policy;
    // with no NAT it is the widest remaining path out of the VPC.
    for (const c of [...APP, this.alb]) {
      allow(this.vpce, c, PORT.https, 'AWS API access');
    }

    if (props.prometheus) {
      for (const t of APP) {
        allow(t, props.prometheus, PORT.metrics, 'prometheus scrape');
      }
    }
  }
}

/*
Attach at service creation — omit `securityGroups` and CDK makes its own with
open egress, which defeats the mesh:

  new ecs.FargateService(this, 'Scheduler', {
    cluster, taskDefinition,
    securityGroups: [sgs.control],
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  });

  api-server -> sgs.api      scheduler / dag-processor / triggerer -> sgs.control
  workers    -> sgs.worker   ops EcsRunTask                        -> sgs.control

Don't use ApplicationLoadBalancedFargateService; it manages its own SG.

If dev fronts its redis container with an NLB, the NLB needs its own SG passed
at creation (it cannot be added later), and redis accepts 6379 from that
instead of from control/worker directly.
*/
