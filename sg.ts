/**
 * Airflow 3.2.0 on ECS Fargate — security group mesh.
 *
 * EGRESS POSTURE
 * --------------
 * Every SG is created with allowAllOutbound: true, deliberately.
 *
 * This VPC has no NAT gateway. Private subnets have no route to the internet,
 * so SG egress rules would duplicate a constraint the route tables already
 * enforce — at the cost of ~20 extra rules and a recurring failure mode where
 * a missing rule presents as a task hanging until timeout with nothing useful
 * in the logs.
 *
 * The security argument rests entirely on INGRESS, which is unchanged:
 *
 *   - Workers cannot reach the metadata database. rdsSg does not accept them.
 *     Unrestricted worker egress does not help a worker find a listener that
 *     isn't there. This is the AIP-72 boundary and it is intact.
 *   - The UI is reachable only from operator laptops, via the public ALB.
 *   - The Task Execution API is reachable only from inside, via the internal ALB.
 *
 * What this posture does NOT cover, and what must be controlled elsewhere:
 *
 *   1. The S3 GATEWAY ENDPOINT has no security group. A task can PutObject to
 *      any bucket in the region, including outside this account. Constrain it
 *      with an endpoint policy (aws:PrincipalOrgID, or a bucket allowlist).
 *      With no NAT, this is the primary remaining exfiltration path.
 *   2. TRANSIT GATEWAY / DIRECT CONNECT routes. "No NAT" is not "no egress" if
 *      a TGW attachment routes toward the corporate network. Confirm the route
 *      table scope; unrestricted egress plus a broad TGW route is a lateral
 *      movement path.
 *   3. IAM. The network boundary must match the permission boundary — check
 *      whether workers still hold Secrets Manager read for connections.
 *
 * If a NAT gateway is ever added to this VPC, this decision must be revisited:
 * workerSg and dagProcessorSg run code this team does not fully control, and
 * they would need allowAllOutbound: false. Note that the flag is immutable
 * after construction — flipping it replaces the security group.
 *
 * OTHER RULES ENCODED HERE
 * ------------------------
 *  - One SG per role. No shared "airflow-common" SG with a self-referencing
 *    rule, which would undo the AIP-72 boundary at the network layer.
 *  - Two-pass wiring: construct all SGs, then attach rules. Interleaving the
 *    two is how you get a CloudFormation circular dependency.
 *  - Sidecars (statsd-exporter, ADOT) share the task ENI. Their ports are
 *    loopback and deliberately have no rules.
 */

import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Tags } from 'aws-cdk-lib';

// ---------------------------------------------------------------------------
// Client access
// ---------------------------------------------------------------------------

/**
 * How operator laptops reach the Airflow UI.
 *
 * A security group can only reference workloads with an ENI inside the VPC.
 * Laptops do not have one, so only these variants are expressible:
 *
 *   - clientVpn  : the Client VPN endpoint has its own SG and connected
 *                  laptops source traffic from it. The only variant where an
 *                  SG genuinely represents a fleet of laptops.
 *   - privateLink: an interface endpoint ENI in a consumer VPC.
 *   - prefixList : laptops arrive over Direct Connect / TGW from a corporate
 *                  range. No ENI, so no SG. A customer-managed prefix list is
 *                  the correct abstraction — one named, versioned object to
 *                  audit and update.
 *   - cidr       : escape hatch. Avoid in regulated envs; it scatters ranges
 *                  across rules with no single place to review them.
 */
export type ClientAccess =
  | { kind: 'clientVpn'; securityGroup?: ec2.ISecurityGroup }
  | { kind: 'privateLink'; securityGroup: ec2.ISecurityGroup }
  | { kind: 'prefixList'; prefixListId: string }
  | { kind: 'cidr'; cidrs: string[] };

export interface AirflowSecurityGroupsProps {
  readonly vpc: ec2.IVpc;

  /** 'dev' | 'staging' | 'prod' — naming and tagging only. */
  readonly envName: string;

  readonly clientAccess: ClientAccess;

  /**
   * 'elasticache' upper, 'container' lower. Upper envs talk to the primary
   * endpoint directly; lower envs front a Redis Fargate service with an NLB.
   */
  readonly brokerMode: 'elasticache' | 'container';

  /**
   * Route control-plane DB traffic through RDS Proxy, collapsing the RDS
   * ingress list to a single peer. Measure
   * DatabaseConnectionsCurrentlySessionPinned before assuming it relieves
   * connection pressure — the scheduler's HA locking pins sessions.
   */
  readonly useRdsProxy?: boolean;

  /** Where an external Prometheus scrapes from. */
  readonly prometheusPeer?: ec2.IPeer;
}

const PORT = {
  https: ec2.Port.tcp(443),
  apiServer: ec2.Port.tcp(8080), // UI + REST API + Task Execution API
  postgres: ec2.Port.tcp(5432),
  redis: ec2.Port.tcp(6379),
  metrics: ec2.Port.tcp(9102), // statsd-exporter /metrics
} as const;

// ---------------------------------------------------------------------------

export class AirflowSecurityGroups extends Construct {
  /** Represents operator laptops. Populated only for clientVpn/privateLink. */
  public readonly clientSg?: ec2.ISecurityGroup;

  public readonly albPublicSg: ec2.SecurityGroup;
  public readonly albExecSg: ec2.SecurityGroup;
  public readonly apiServerSg: ec2.SecurityGroup;
  public readonly schedulerSg: ec2.SecurityGroup;
  public readonly dagProcessorSg: ec2.SecurityGroup;
  public readonly triggererSg: ec2.SecurityGroup;
  public readonly workerSg: ec2.SecurityGroup;
  public readonly opsSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly rdsProxySg?: ec2.SecurityGroup;

  /**
   * Container mode only. MUST be passed to the NLB at creation time — NLB
   * security groups cannot be associated afterwards, so an existing NLB
   * without one has to be replaced.
   */
  public readonly redisNlbSg?: ec2.SecurityGroup;

  /** ElastiCache replication group (upper) or Redis service (lower). */
  public readonly redisSg: ec2.SecurityGroup;

  /**
   * Interface endpoints. With no NAT, this is the ONLY path to the AWS
   * control plane — an SG rule missing here means no ECR pull, no logs, no
   * Secrets Manager. Failures look like tasks stuck in PROVISIONING.
   */
  public readonly vpceSg: ec2.SecurityGroup;

  /** Every SG running Airflow application code. */
  public readonly appSgs: ec2.SecurityGroup[];

  /** SGs permitted to open a Postgres session. Never includes workerSg. */
  public readonly dbClientSgs: ec2.SecurityGroup[];

  constructor(scope: Construct, id: string, props: AirflowSecurityGroupsProps) {
    super(scope, id);

    const { vpc, envName, clientAccess } = props;

    const sg = (name: string, description: string) => {
      const group = new ec2.SecurityGroup(this, name, {
        vpc,
        description: `${envName} airflow — ${description}`,
        securityGroupName: `${envName}-airflow-${name.toLowerCase()}`,
        // See the egress note at the top of this file. There is no NAT
        // gateway; route tables carry the egress constraint. Immutable after
        // construction — changing this replaces the SG.
        allowAllOutbound: true,
      });
      Tags.of(group).add('airflow:role', name);
      Tags.of(group).add('airflow:env', envName);
      return group;
    };

    // ---- Pass 1: construct every SG before wiring anything ----------------

    if (clientAccess.kind === 'clientVpn') {
      this.clientSg =
        clientAccess.securityGroup ??
        sg('Client', 'operator laptops, via the Client VPN endpoint');
    } else if (clientAccess.kind === 'privateLink') {
      this.clientSg = clientAccess.securityGroup;
    }

    this.albPublicSg = sg('AlbPublic', 'ALB fronting the Airflow UI/REST API');
    this.albExecSg = sg('AlbExec', 'internal ALB fronting the Task Execution API');
    this.apiServerSg = sg('ApiServer', 'api-server tasks');
    this.schedulerSg = sg('Scheduler', 'scheduler tasks');
    this.dagProcessorSg = sg('DagProcessor', 'dag-processor tasks');
    this.triggererSg = sg('Triggerer', 'triggerer tasks');
    this.workerSg = sg('Worker', 'celery worker tasks — no metadata DB access');
    this.opsSg = sg('Ops', 'one-shot ops CLI / db migration tasks');
    this.rdsSg = sg('Rds', 'RDS PostgreSQL metadata database');
    this.vpceSg = sg('Vpce', 'interface VPC endpoints');

    this.redisSg = sg(
      'Redis',
      props.brokerMode === 'elasticache'
        ? 'ElastiCache replication group (celery broker)'
        : 'redis container service (celery broker)',
    );

    if (props.brokerMode === 'container') {
      this.redisNlbSg = sg('RedisNlb', 'NLB fronting the redis container');
    }

    if (props.useRdsProxy) {
      this.rdsProxySg = sg('RdsProxy', 'RDS Proxy in front of the metadata DB');
    }

    this.appSgs = [
      this.apiServerSg,
      this.schedulerSg,
      this.dagProcessorSg,
      this.triggererSg,
      this.workerSg,
      this.opsSg,
    ];

    // The whole point of AIP-72: workerSg is absent from this list.
    this.dbClientSgs = [
      this.apiServerSg,
      this.schedulerSg,
      this.dagProcessorSg,
      this.triggererSg,
      this.opsSg,
    ];

    // ---- Pass 2: ingress rules -------------------------------------------
    //
    // Ingress only. With allowAllOutbound: true, connections.allowFrom would
    // skip the egress half anyway; addIngressRule states that outright so no
    // reader has to know the CDK behaviour.

    this.wireClientAccess(clientAccess);
    this.wireUiPath();
    this.wireExecutionApiPath();
    this.wireDatabasePath();
    this.wireBrokerPath(props);
    this.wireEndpointPath();
    this.wireScrapePath(props);
  }

  /** target accepts `port` from source. */
  private allow(
    target: ec2.SecurityGroup,
    source: ec2.ISecurityGroup,
    port: ec2.Port,
    description: string,
  ) {
    target.addIngressRule(
      ec2.Peer.securityGroupId(source.securityGroupId),
      port,
      description,
    );
  }

  // -- laptops -> public ALB ----------------------------------------------

  private wireClientAccess(access: ClientAccess) {
    const desc = 'operator laptops -> Airflow UI';

    switch (access.kind) {
      case 'clientVpn':
      case 'privateLink':
        this.allow(this.albPublicSg, this.clientSg!, PORT.https, desc);
        break;
      case 'prefixList':
        this.albPublicSg.addIngressRule(
          ec2.Peer.prefixList(access.prefixListId),
          PORT.https,
          `${desc} (via corporate prefix list)`,
        );
        break;
      case 'cidr':
        access.cidrs.forEach((cidr) =>
          this.albPublicSg.addIngressRule(ec2.Peer.ipv4(cidr), PORT.https, desc),
        );
        break;
    }
  }

  // -- public ALB -> api-server -------------------------------------------

  private wireUiPath() {
    // The api-server is the only thing behind the public ALB. Workers take no
    // inbound traffic at all except the prometheus scrape.
    this.allow(
      this.apiServerSg,
      this.albPublicSg,
      PORT.apiServer,
      'public ALB -> api-server (UI + REST API)',
    );
  }

  // -- workers -> internal ALB -> api-server ------------------------------

  private wireExecutionApiPath() {
    // dag-processor and triggerer resolve variables/connections through the
    // execution API as well as holding their own DB sessions.
    for (const peer of [this.workerSg, this.dagProcessorSg, this.triggererSg]) {
      this.allow(
        this.albExecSg,
        peer,
        PORT.apiServer,
        `${peer.node.id} -> internal ALB (Task Execution API)`,
      );
    }

    this.allow(
      this.apiServerSg,
      this.albExecSg,
      PORT.apiServer,
      'internal ALB -> api-server (Task Execution API)',
    );
  }

  // -- control plane -> Postgres ------------------------------------------

  private wireDatabasePath() {
    const target = this.rdsProxySg ?? this.rdsSg;

    for (const client of this.dbClientSgs) {
      this.allow(target, client, PORT.postgres, `${client.node.id} -> metadata database`);
    }

    if (this.rdsProxySg) {
      this.allow(
        this.rdsSg,
        this.rdsProxySg,
        PORT.postgres,
        'RDS Proxy -> RDS PostgreSQL',
      );
    }
  }

  // -- celery broker -------------------------------------------------------

  private wireBrokerPath(props: AirflowSecurityGroupsProps) {
    // Scheduler publishes (the CeleryExecutor runs in-process), workers consume.
    //
    // Workers appear here and NOT on the database path. That only holds if
    // [celery] result_backend points at Redis. Leave it at the db+postgresql://
    // default and workers will need 5432, and the AIP-72 boundary is gone.
    const brokerClients = [this.schedulerSg, this.workerSg];

    if (this.redisNlbSg) {
      // Lower envs, two hops: task SG -> NLB SG -> redis service SG.
      //
      // Security group referencing works regardless of the client IP
      // preservation setting, which matters because IP-type TCP target groups
      // default it to off — the redis task would otherwise see only the NLB's
      // private IPs and you'd be back to allowlisting subnet CIDRs.
      for (const client of brokerClients) {
        this.allow(this.redisNlbSg, client, PORT.redis, `${client.node.id} -> redis NLB`);
      }
      this.allow(
        this.redisSg,
        this.redisNlbSg,
        PORT.redis,
        'redis NLB -> redis container (includes health checks)',
      );
    } else {
      // Upper envs, one hop. ElastiCache's primary endpoint follows failover
      // on its own, so there is nothing to re-register and no idle timeout to
      // tune.
      for (const client of brokerClients) {
        this.allow(
          this.redisSg,
          client,
          PORT.redis,
          `${client.node.id} -> ElastiCache primary endpoint`,
        );
      }
    }

    void props;
  }

  // -- everything -> interface endpoints -----------------------------------

  private wireEndpointPath() {
    // ECR api/dkr, CloudWatch Logs, Secrets Manager, SSM, STS, KMS.
    // S3 is a GATEWAY endpoint: no SG, authorized by route table and endpoint
    // policy. That policy is the real exfiltration control here — see the note
    // at the top of this file.
    const clients: ec2.ISecurityGroup[] = [
      ...this.appSgs,
      this.albPublicSg,
      this.albExecSg,
    ];

    // In container mode the redis service is a Fargate task and needs image
    // pulls and log shipping. ElastiCache is managed and needs nothing.
    if (this.redisNlbSg) clients.push(this.redisSg);

    for (const client of clients) {
      this.allow(
        this.vpceSg,
        client,
        PORT.https,
        `${client.node.id} -> interface VPC endpoints`,
      );
    }
  }

  // -- prometheus scrape ---------------------------------------------------

  private wireScrapePath(props: AirflowSecurityGroupsProps) {
    if (!props.prometheusPeer) return;

    // Scrape targets are task IPs discovered via Cloud Map, so the peer is the
    // Prometheus host, not a load balancer.
    for (const target of this.appSgs) {
      target.addIngressRule(
        props.prometheusPeer,
        PORT.metrics,
        'prometheus -> statsd-exporter /metrics',
      );
    }
  }

  /**
   * Fails synth if anything has granted workers a path to Postgres.
   *
   * This matters MORE now that egress is unrestricted: the worker/database
   * boundary is carried entirely by the absence of an ingress rule, so there
   * is no second layer to catch a mistake. Call it from the stack.
   */
  public assertWorkerDbIsolation(): void {
    const offending = this.rdsSg.node
      .findAll()
      .concat(this.rdsProxySg?.node.findAll() ?? [])
      .filter((c): c is ec2.CfnSecurityGroupIngress => c instanceof ec2.CfnSecurityGroupIngress)
      .filter((r) => r.sourceSecurityGroupId === this.workerSg.securityGroupId);

    if (offending.length > 0) {
      throw new Error(
        'Worker security group has ingress to the metadata database. ' +
          'Airflow 3 workers must reach the API server only (AIP-72).',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Environment config — the only thing that varies between envs
// ---------------------------------------------------------------------------

export interface AirflowEnvConfig {
  readonly envName: string;
  readonly multiAz: boolean;
  readonly instanceType: ec2.InstanceType;
  readonly schedulerCount: number;
  readonly apiServerCount: number;
  readonly workerCount: number;
  readonly useRdsProxy: boolean;
  readonly brokerMode: 'elasticache' | 'container';
  /** ElastiCache encryption in transit. Forces rediss:// + broker_use_ssl. */
  readonly brokerTls: boolean;
}

export const AIRFLOW_ENVS: Record<string, AirflowEnvConfig> = {
  dev: {
    envName: 'dev',
    multiAz: false,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
    schedulerCount: 1,
    apiServerCount: 1,
    workerCount: 1,
    useRdsProxy: false,
    brokerMode: 'container',
    brokerTls: false, // no TLS, no auth token — see notes on parity
  },
  staging: {
    envName: 'staging',
    // multiAz true here is what makes failover drills possible before prod.
    multiAz: true,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
    schedulerCount: 2,
    apiServerCount: 2,
    workerCount: 2,
    useRdsProxy: true,
    brokerMode: 'elasticache',
    brokerTls: true,
  },
  prod: {
    envName: 'prod',
    multiAz: true,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.XLARGE),
    schedulerCount: 2,
    apiServerCount: 2,
    workerCount: 4,
    useRdsProxy: true,
    brokerMode: 'elasticache',
    brokerTls: true,
  },
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// const cfg = AIRFLOW_ENVS.staging;
//
// const sgs = new AirflowSecurityGroups(this, 'AirflowSgs', {
//   vpc,
//   envName: cfg.envName,
//   brokerMode: cfg.brokerMode,
//   useRdsProxy: cfg.useRdsProxy,
//   clientAccess: { kind: 'prefixList', prefixListId: corpLaptopPrefixList.ref },
//   prometheusPeer: ec2.Peer.securityGroupId(prometheusSg.securityGroupId),
// });
// sgs.assertWorkerDbIsolation();
//
// --- RDS ------------------------------------------------------------------
//
// Build the DB subnet group across >= 2 AZs in EVERY env, including dev where
// multiAz is false. A single-AZ subnet group cannot be flipped to Multi-AZ
// later without replacing the instance.
//
// new rds.DatabaseInstance(this, 'AirflowDb', {
//   vpc,
//   vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, // spans AZs
//   multiAz: cfg.multiAz,
//   instanceType: cfg.instanceType,
//   securityGroups: [sgs.rdsSg],
//   engine: rds.DatabaseInstanceEngine.postgres({
//     version: rds.PostgresEngineVersion.VER_16_4,
//   }),
// });
//
// --- Fargate services ------------------------------------------------------
//
// securityGroups is set at service creation. Omit it and CDK silently creates
// its own SG, which defeats the mesh above — always pass it explicitly.
//
// const service = (id: string, taskDef: ecs.FargateTaskDefinition,
//                  securityGroup: ec2.ISecurityGroup, desiredCount: number) =>
//   new ecs.FargateService(this, id, {
//     cluster,
//     taskDefinition: taskDef,
//     desiredCount,
//     securityGroups: [securityGroup],
//     vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
//     assignPublicIp: false,
//     circuitBreaker: { rollback: true },
//     minHealthyPercent: 100,
//     maxHealthyPercent: 200, // note: doubles DB connections mid-deploy
//   });
//
// const apiServer    = service('ApiServer',    apiServerTask,    sgs.apiServerSg,    cfg.apiServerCount);
// const scheduler    = service('Scheduler',    schedulerTask,    sgs.schedulerSg,    cfg.schedulerCount);
// const dagProcessor = service('DagProcessor', dagProcessorTask, sgs.dagProcessorSg, 1);
// const triggerer    = service('Triggerer',    triggererTask,    sgs.triggererSg,    2);
// const worker       = service('Worker',       workerTask,       sgs.workerSg,       cfg.workerCount);
//
// Register the api-server with both listeners; the SG rules already exist.
//   publicListener.addTargets('ApiServerUi', { port: 8080, targets: [apiServer] });
//   execListener.addTargets('ApiServerExec', { port: 8080, targets: [apiServer] });
//
// One-shot ops tasks have no service; the SG is passed at run time:
//   new tasks.EcsRunTask(this, 'DbMigrate', {
//     securityGroups: [sgs.opsSg],
//     launchTarget: new tasks.EcsFargateLaunchTarget(),
//     // ...
//   });
//
// Do NOT use ApplicationLoadBalancedFargateService — it manages its own SG and
// you lose the ability to pin the api-server to apiServerSg.
//
// --- Redis NLB (LOWER ENVS ONLY) -------------------------------------------
//
// Upper envs skip all of this and point the broker URL at the ElastiCache
// primary endpoint. sgs.redisNlbSg is undefined there.
//
// if (sgs.redisNlbSg) {
//   const redisNlb = new elbv2.NetworkLoadBalancer(this, 'RedisNlb', {
//     vpc,
//     internetFacing: false,
//     vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
//     securityGroups: [sgs.redisNlbSg], // creation-time only, cannot be added later
//   });
//   const listener = redisNlb.addListener('RedisListener', { port: 6379 });
//
//   // The generic service() helper uses 100/200 for rolling deploys. Do NOT
//   // do that here: two redis containers behind one target group means two
//   // independent brokers, and messages queued on the departing one go
//   // invisible — tasks appear to vanish mid-deploy.
//   const redisService = new ecs.FargateService(this, 'Redis', {
//     cluster,
//     taskDefinition: redisTask,
//     desiredCount: 1,
//     securityGroups: [sgs.redisSg],
//     vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
//     minHealthyPercent: 0,   // brief broker outage, correct behaviour
//     maxHealthyPercent: 100, // never two brokers at once
//   });
//
//   // ECS keeps target registration current across deploys by itself.
//   redisService.registerLoadBalancerTargets({
//     containerName: 'redis',
//     containerPort: 6379,
//     newTargetGroupId: 'RedisTg',
//     listener: ecs.ListenerConfig.networkListener(listener),
//   });
// }
//
// The NLB's 350s TCP idle timeout applies only in lower envs. Celery workers
// hold idle broker connections while polling, so set socket_keepalive below
// that threshold — otherwise dev shows worker hangs that upper envs never
// reproduce.
