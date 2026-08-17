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
   * The group holding the client ranges that may reach the UI on 443.
   *
   * ATTACH it to the ALB — do not let anything reference it as a source peer.
   * That distinction decides whether this works: a group holding a list of
   * CIDRs grants nothing when referenced by another group, because SG rules
   * are not transitive. Referencing group A means "traffic from ENIs carrying
   * A", not "traffic matching A's own rules". The failure is silent — clean
   * synth, successful deploy, unreachable UI.
   *
   *   securityGroups: sgs.albSecurityGroups
   *
   * Nothing in this construct adds rules to it, so pass it imported with
   * mutable: false if it is owned by another stack.
   */
  readonly uiClients: ec2.ISecurityGroup;

  /** Where Prometheus scrapes from. Omit if you don't scrape. */
  readonly prometheus?: ec2.IPeer;

  /**
   * True in envs where an NLB fronts the redis container, false where the
   * broker is ElastiCache. When true, this construct creates `redisNlb` and
   * you pass it to the NLB at creation:
   *
   *   securityGroups: [sgs.redisNlb!]
   *
   * Creation time is the only time. A security group cannot be associated
   * with an NLB afterwards, so adding this property to an NLB that is already
   * deployed REPLACES it — new load balancer, new DNS name, brief broker
   * outage. Fine in a lower env, but expect the replacement in the diff.
   */
  readonly redisViaNlb?: boolean;

  /**
   * The internal ALB workers reach the api-server through. Import it MUTABLE —
   * this construct adds the 8080 ingress rules to it.
   */
  readonly execAlb: ec2.ISecurityGroup;

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
  api: ec2.Port.tcp(8080),
  postgres: ec2.Port.tcp(5432),
  redis: ec2.Port.tcp(6379),
  metrics: ec2.Port.tcp(9102),
};

export class AirflowSecurityGroups extends Construct {
  /** The ALB's own group. Holds no client ranges; those live on `uiClients`. */
  readonly alb: ec2.SecurityGroup;

  /**
   * Exactly what the ALB should be given: its own group plus the client
   * group. Spread this rather than passing `alb` alone — forgetting the
   * client group is the one mistake here that deploys cleanly and leaves the
   * UI unreachable.
   */
  readonly albSecurityGroups: ec2.ISecurityGroup[];
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

  /** Present only when redisViaNlb. Pass to the NLB at creation. */
  readonly redisNlb?: ec2.SecurityGroup;
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

    this.alb = sg('Alb', 'ALB fronting the Airflow UI');
    this.albSecurityGroups = [this.alb, props.uiClients];
    this.api = sg('Api', 'api-server');
    this.scheduler = sg('Scheduler', 'scheduler');
    this.dagProcessor = sg('DagProcessor', 'dag-processor');
    this.triggerer = sg('Triggerer', 'triggerer');
    this.worker = sg('Worker', 'celery workers');
    this.manualTask = sg('ManualTask', 'migrations and one-shot CLI tasks');
    this.redis = sg('Redis', 'celery broker');
    if (props.redisViaNlb) {
      this.redisNlb = sg('RedisNlb', 'NLB fronting the redis container');
    }

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

    // UI. The client ranges live on props.uiClients, attached to the ALB, so
    // nothing here references them. If those ranges are broad (10/8), every
    // workload in the VPC can reach the UI — a known gap, but confined to
    // port 443 on one load balancer. Nothing else in this mesh accepts a
    // CIDR: the database and broker take only named service groups.
    allow(this.api, this.alb, PORT.api, 'ALB -> api-server');

    // Task Execution API: client -> internal ALB -> api-server.
    for (const c of EXEC_API_CLIENTS) {
      allow(props.execAlb, c, PORT.api, `${c.node.id} -> internal ALB`);
    }
    allow(this.api, props.execAlb, PORT.api, 'internal ALB -> api-server');

    // Metadata database
    for (const c of DB_CLIENTS) {
      allow(this.rds, c, PORT.postgres, `${c.node.id} -> metadata DB`);
    }

    // Broker. Requires [celery] result_backend on redis, NOT db+postgresql://,
    // or workers would need the database and the boundary above is void.
    if (this.redisNlb) {
      // Two hops: client -> NLB -> redis container.
      //
      // Referencing the NLB's group works regardless of the client IP
      // preservation setting. That matters: IP-type TCP target groups default
      // preservation to OFF, so without a group on the NLB the redis task
      // would see only the NLB's private addresses and you would be back to
      // allowlisting subnet CIDRs — which admits everything else in those
      // subnets too.
      //
      // The second rule also covers the NLB's health checks; they originate
      // from the same ENIs.
      for (const c of BROKER_CLIENTS) {
        allow(this.redisNlb, c, PORT.redis, `${c.node.id} -> redis NLB`);
      }
      allow(this.redis, this.redisNlb, PORT.redis, 'redis NLB -> redis container');
    } else {
      for (const c of BROKER_CLIENTS) {
        allow(this.redis, c, PORT.redis, `${c.node.id} -> celery broker`);
      }
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
    securityGroups: sgs.albSecurityGroups,
  });

  api-server    -> sgs.api           dag-processor -> sgs.dagProcessor
  scheduler     -> sgs.scheduler     triggerer     -> sgs.triggerer
  workers       -> sgs.worker        manual tasks  -> sgs.manualTask

Don't use ApplicationLoadBalancedFargateService; it manages its own SG.

The redis SG works in both modes: attach it to the ElastiCache replication
group in upper envs, or to the redis Fargate service in lower envs. Same
ingress either way.

In envs with an NLB in front of the redis container, set redisViaNlb and hand
the group it creates to the NLB:

  new elbv2.NetworkLoadBalancer(this, 'RedisNlb', {
    vpc, internetFacing: false,
    securityGroups: [sgs.redisNlb!],   // creation-time only
  });

and the redis service registers itself as a target, so ECS keeps registration
current across deploys:

  redisService.registerLoadBalancerTargets({
    containerName: 'redis', containerPort: 6379,
    newTargetGroupId: 'RedisTg',
    listener: ecs.ListenerConfig.networkListener(listener),
  });

Set desiredCount 1 with minHealthyPercent 0 / maxHealthyPercent 100 on that
service. The usual 100/200 rolling deploy would briefly run two redis
containers behind one target group — two independent brokers, with messages
queued on the departing one going invisible.

Because the NLB is created here rather than imported, it gets its group at
creation and none of the "cannot associate afterwards" problem applies. The
only consequence is that an already-deployed NLB is replaced on the first
apply of this change.
*/
