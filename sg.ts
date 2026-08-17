/**
 * Airflow 3.2 on Fargate — security groups.
 *
 * Egress is unrestricted everywhere: this VPC has no NAT gateway, so route
 * tables already prevent tasks from reaching the internet. SG egress rules
 * would only duplicate that. Revisit if a NAT is ever added.
 *
 * One SG per service. Scheduler, dag-processor, and triggerer share a trust
 * tier — all three hold full read/write on the metadata database — so the
 * split buys attribution in flow logs rather than containment. `manualTask` is
 * the one that earns it outright: traffic to 5432 from `manualTask` means a
 * human ran a migration, which is a distinguishable and auditable signal.
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

  /**
   * Ranges allowed to reach the UI on 443, e.g. ['10.0.0.0/8'].
   *
   * These become ingress rules on `uiClients`, which is ATTACHED to the ALB.
   * That distinction is the whole point: a security group holding a list of
   * CIDRs does nothing when REFERENCED as a source by another group. SG rules
   * are not transitive — referencing group A means "traffic from ENIs
   * carrying A", not "traffic matching A's own rules". The failure is silent:
   * the rule synthesizes, the deploy succeeds, the UI is unreachable.
   *
   * So: attach `uiClients` to every load balancer that should accept these
   * ranges. Never pass it as a source peer.
   */
  readonly uiClientCidrs: string[];

  /** Where Prometheus scrapes from. Omit if you don't scrape. */
  readonly prometheus?: ec2.IPeer;

  /**
   * The RDS instance's own security group, created by the data stack.
   *
   * Import it MUTABLE and inside the stack that instantiates this construct,
   * so the 5432 ingress rules are synthesized there and the dependency runs
   * runtime -> data. Importing it in the data stack instead reverses that and
   * CloudFormation rejects the cycle.
   */
  readonly rds: ec2.ISecurityGroup;
}

const PORT = {
  https: ec2.Port.tcp(443),
  api: ec2.Port.tcp(8080),
  postgres: ec2.Port.tcp(5432),
  redis: ec2.Port.tcp(6379),
  metrics: ec2.Port.tcp(9102),
};

export class AirflowSecurityGroups extends Construct {
  /**
   * Carries the client ranges. ATTACH this to the ALB alongside `alb`, and to
   * any other load balancer in this stack serving a UI to the same audience.
   * Keeping the ranges in one named group means tightening them later — when
   * a customer-managed prefix list exists — is a one-line change here rather
   * than an audit of every rule.
   */
  readonly uiClients: ec2.SecurityGroup;

  /** The ALB's own group. Holds no client ranges; those live on `uiClients`. */
  readonly alb: ec2.SecurityGroup;
  /** api-server: serves the UI and the Task Execution API. */
  readonly api: ec2.SecurityGroup;
  readonly scheduler: ec2.SecurityGroup;
  readonly dagProcessor: ec2.SecurityGroup;
  readonly triggerer: ec2.SecurityGroup;
  /** celery workers — run DAG code, no database access. */
  readonly worker: ec2.SecurityGroup;
  /** One-shot migrations and CLI tasks. Separate so DB access is attributable. */
  readonly manualTask: ec2.SecurityGroup;
  /** Celery broker: ElastiCache replication group, or the redis Fargate service. */
  readonly redis: ec2.SecurityGroup;
  /** The imported RDS group. Rules on it are added here, not in the data stack. */
  readonly rds: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: AirflowSecurityGroupsProps) {
    super(scope, id);

    const sg = (name: string, description: string) =>
      new ec2.SecurityGroup(this, name, {
        vpc: props.vpc,
        description: `${props.envName} airflow — ${description}`,
        allowAllOutbound: true, // see header
      });

    this.uiClients = sg('UiClients', 'ranges allowed to reach Airflow UIs');
    this.alb = sg('Alb', 'ALB fronting the Airflow UI');
    this.api = sg('Api', 'api-server');
    this.scheduler = sg('Scheduler', 'scheduler');
    this.dagProcessor = sg('DagProcessor', 'dag-processor');
    this.triggerer = sg('Triggerer', 'triggerer');
    this.worker = sg('Worker', 'celery workers');
    this.manualTask = sg('ManualTask', 'migrations and one-shot CLI tasks');
    this.redis = sg('Redis', 'celery broker');

    this.rds = props.rds;

    const APP = [
      this.api,
      this.scheduler,
      this.dagProcessor,
      this.triggerer,
      this.worker,
      this.manualTask,
    ];

    // Deliberately not worker. This absence is the AIP-72 boundary.
    const DB_CLIENTS = [
      this.api,
      this.scheduler,
      this.dagProcessor,
      this.triggerer,
      this.manualTask,
    ];

    // Resolve variables and connections through the api-server.
    const EXEC_API_CLIENTS = [this.worker, this.dagProcessor, this.triggerer];

    // Scheduler publishes (CeleryExecutor runs in-process), workers consume.
    const BROKER_CLIENTS = [this.scheduler, this.worker];

    const allow = (
      target: ec2.ISecurityGroup,
      source: ec2.IPeer,
      port: ec2.Port,
      why: string,
    ) => target.addIngressRule(source, port, why);

    // UI. The ranges land on uiClients, which is attached to the ALB — see
    // the note on uiClientCidrs. A broad range here (10/8) means every
    // workload in the VPC can reach the UI, not just laptops. That is a known
    // gap pending a prefix list; it is deliberately confined to this one
    // group and to port 443 on the ALB. Nothing else in this mesh accepts a
    // CIDR: the database and broker take only named service groups.
    for (const cidr of props.uiClientCidrs) {
      allow(this.uiClients, ec2.Peer.ipv4(cidr), PORT.https, `${cidr} -> Airflow UI`);
    }

    allow(this.api, this.alb, PORT.api, 'ALB -> api-server');

    // Task Execution API (clients reach the api-server via Cloud Map)
    for (const c of EXEC_API_CLIENTS) {
      allow(this.api, c, PORT.api, `${c.node.id} -> execution API`);
    }

    // Metadata database
    for (const c of DB_CLIENTS) {
      allow(this.rds, c, PORT.postgres, `${c.node.id} -> metadata DB`);
    }

    // Broker. Requires [celery] result_backend on redis, NOT db+postgresql://,
    // or workers would need the database and the boundary above is void.
    for (const c of BROKER_CLIENTS) {
      allow(this.redis, c, PORT.redis, `${c.node.id} -> celery broker`);
    }

    // Nothing here for AWS API access. The VPC's interface endpoints are
    // managed elsewhere and their SG admits the VPC CIDR; egress is
    // unrestricted, so these tasks already reach them. S3 is a gateway
    // endpoint with no SG at all — with no NAT it is the widest remaining
    // path out of the VPC, and nothing in this file can constrain it.

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
    securityGroups: [sgs.scheduler],
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  });

The ALB carries TWO groups — its own, plus the one holding the client ranges:

  new elbv2.ApplicationLoadBalancer(this, 'Alb', {
    vpc, internetFacing: false,
    securityGroups: [sgs.alb, sgs.uiClients],
  });

  api-server    -> sgs.api           dag-processor -> sgs.dagProcessor
  scheduler     -> sgs.scheduler     triggerer     -> sgs.triggerer
  workers       -> sgs.worker        manual tasks  -> sgs.manualTask

Don't use ApplicationLoadBalancedFargateService; it manages its own SG.

The redis SG works in both modes: attach it to the ElastiCache replication
group in upper envs, or to the redis Fargate service in lower envs. Same
ingress either way.

The exception is the NLB. If dev keeps one in front of the redis container,
the NLB needs its own SG passed at creation (it cannot be added afterwards),
and redis accepts 6379 from that SG instead of from scheduler/worker. Simpler:
drop the NLB and let workers resolve redis through Cloud Map, the same way
they now reach the api-server. Then this file is correct as written.
*/
