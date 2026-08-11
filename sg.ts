/**
 * Airflow 3.2.0 on ECS Fargate — security group mesh.
 *
 * Design rules encoded here:
 *
 *  1. One SG per role. No shared "airflow-common" SG with a self-referencing
 *     rule — that would silently undo the AIP-72 boundary at the network layer.
 *
 *  2. Workers have NO path to the metadata DB. In Airflow 3 only the control
 *     plane (scheduler, api-server, dag-processor, triggerer) touches Postgres.
 *     Workers reach the Task Execution API over the internal ALB.
 *     If you see a 5432 rule referencing workerSg, something regressed.
 *
 *  3. Every SG is constructed with allowAllOutbound: false. This is immutable
 *     after construction — addEgressRule on an allowAllOutbound SG is ignored.
 *
 *  4. Two-pass wiring. All SGs are constructed first, then rules are attached.
 *     Interleaving construction and cross-references is how you end up with a
 *     CloudFormation circular dependency.
 *
 *  5. Sidecars (statsd-exporter, ADOT collector) share the task ENI. Their
 *     ports are loopback and deliberately have no SG rules.
 *
 *  6. The S3 gateway endpoint has no SG — it is authorized via route table and
 *     endpoint policy, not here.
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
 * IMPORTANT: a security group can only reference workloads that have an ENI
 * inside the VPC. Laptops do not. "A security group representing all the
 * laptops" is only expressible in the cases below:
 *
 *   - clientVpn  : the AWS Client VPN endpoint has its own SG, and traffic from
 *                  connected laptops is sourced from that SG. This is the only
 *                  variant where an SG genuinely represents a fleet of laptops.
 *   - privateLink: an interface endpoint ENI in a consumer VPC, SG-addressable.
 *   - prefixList : laptops arrive over Direct Connect / transit gateway from a
 *                  corporate range. There is no ENI, so no SG. A customer-
 *                  managed prefix list is the correct abstraction — it gives
 *                  you one named object to audit and update, which is as close
 *                  to "a client SG" as this path allows.
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

  /** 'dev' | 'staging' | 'prod' — used for naming and tagging only. */
  readonly envName: string;

  readonly clientAccess: ClientAccess;

  /**
   * Route control-plane DB traffic through RDS Proxy. Collapses the RDS
   * ingress list to a single peer. Measure DatabaseConnectionsCurrentlySession
   * Pinned before assuming it fixes connection pressure — the scheduler's HA
   * locking pins sessions.
   */
  readonly useRdsProxy?: boolean;

  /** Flower is an extra attack surface. Off unless you actively use it. */
  readonly enableFlower?: boolean;

  /**
   * Where an external Prometheus scrapes from (it discovers tasks via Cloud
   * Map and connects to task IPs directly, so the LB is not in this path).
   */
  readonly prometheusPeer?: ec2.IPeer;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

const PORT = {
  https: ec2.Port.tcp(443),
  apiServer: ec2.Port.tcp(8080), // UI + REST API + Task Execution API
  flower: ec2.Port.tcp(5555),
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
  public readonly redisSg: ec2.SecurityGroup;
  public readonly vpceSg: ec2.SecurityGroup;

  /** Every SG that runs Airflow application code. */
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
        // Immutable after construction. Do not flip this to true "temporarily".
        allowAllOutbound: false,
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
    this.redisSg = sg('Redis', 'ElastiCache Redis celery broker');
    this.vpceSg = sg('Vpce', 'interface VPC endpoints');

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

    // ---- Pass 2: wire rules ----------------------------------------------

    this.wireClientAccess(clientAccess);
    this.wireUiPath(props);
    this.wireExecutionApiPath();
    this.wireDatabasePath(props);
    this.wireBrokerPath();
    this.wireEndpointPath();
    this.wireScrapePath(props);
  }

  // -- laptops -> public ALB ----------------------------------------------

  private wireClientAccess(access: ClientAccess) {
    const desc = 'operator laptops -> Airflow UI';

    switch (access.kind) {
      case 'clientVpn':
      case 'privateLink':
        this.albPublicSg.connections.allowFrom(this.clientSg!, PORT.https, desc);
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

  private wireUiPath(props: AirflowSecurityGroupsProps) {
    this.apiServerSg.connections.allowFrom(
      this.albPublicSg,
      PORT.apiServer,
      'public ALB -> api-server (UI + REST API)',
    );

    if (props.enableFlower) {
      this.workerSg.connections.allowFrom(
        this.albPublicSg,
        PORT.flower,
        'public ALB -> flower',
      );
    }
  }

  // -- workers -> internal ALB -> api-server ------------------------------

  private wireExecutionApiPath() {
    this.albExecSg.connections.allowFrom(
      this.workerSg,
      PORT.apiServer,
      'worker -> internal ALB (Task Execution API)',
    );
    this.apiServerSg.connections.allowFrom(
      this.albExecSg,
      PORT.apiServer,
      'internal ALB -> api-server (Task Execution API)',
    );

    // dag-processor and triggerer resolve variables/connections through the
    // execution API as well as holding their own DB sessions.
    for (const peer of [this.dagProcessorSg, this.triggererSg]) {
      this.albExecSg.connections.allowFrom(
        peer,
        PORT.apiServer,
        `${peer.node.id} -> internal ALB (execution API)`,
      );
    }
  }

  // -- control plane -> Postgres ------------------------------------------

  private wireDatabasePath(props: AirflowSecurityGroupsProps) {
    const target = this.rdsProxySg ?? this.rdsSg;

    for (const client of this.dbClientSgs) {
      target.connections.allowFrom(
        client,
        PORT.postgres,
        `${client.node.id} -> metadata database`,
      );
    }

    if (this.rdsProxySg) {
      this.rdsSg.connections.allowFrom(
        this.rdsProxySg,
        PORT.postgres,
        'RDS Proxy -> RDS PostgreSQL',
      );
    }

    void props;
  }

  // -- celery broker -------------------------------------------------------

  private wireBrokerPath() {
    // Scheduler publishes (the CeleryExecutor runs in-process), workers consume.
    //
    // Workers appear here and NOT on the database path. That only holds if
    // [celery] result_backend points at Redis. Leave it at the db+postgresql://
    // default and workers will need 5432, and the AIP-72 boundary is gone.
    for (const client of [this.schedulerSg, this.workerSg]) {
      this.redisSg.connections.allowFrom(
        client,
        PORT.redis,
        `${client.node.id} -> redis broker`,
      );
    }
  }

  // -- everything -> interface endpoints -----------------------------------

  private wireEndpointPath() {
    // ECR api/dkr, CloudWatch Logs, Secrets Manager, SSM, STS.
    // S3 is a gateway endpoint and is not represented here.
    for (const client of [...this.appSgs, this.albPublicSg, this.albExecSg]) {
      this.vpceSg.connections.allowFrom(
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
   * Fails synth if anything has granted workers a path to Postgres. Cheap
   * guard against a well-meaning future edit; call it from the stack.
   */
  public assertWorkerDbIsolation(): void {
    const offending = this.rdsSg.node
      .findAll()
      .concat(this.rdsProxySg?.node.findAll() ?? [])
      .filter((c) => c instanceof ec2.CfnSecurityGroupIngress)
      .map((c) => c as ec2.CfnSecurityGroupIngress)
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
  readonly enableFlower: boolean;
  readonly useRdsProxy: boolean;
}

export const AIRFLOW_ENVS: Record<string, AirflowEnvConfig> = {
  dev: {
    envName: 'dev',
    multiAz: false,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
    schedulerCount: 1,
    apiServerCount: 1,
    enableFlower: true,
    useRdsProxy: false,
  },
  staging: {
    envName: 'staging',
    // multiAz true here is what makes failover drills possible before prod.
    multiAz: true,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
    schedulerCount: 2,
    apiServerCount: 2,
    enableFlower: false,
    useRdsProxy: true,
  },
  prod: {
    envName: 'prod',
    multiAz: true,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.XLARGE),
    schedulerCount: 2,
    apiServerCount: 2,
    enableFlower: false,
    useRdsProxy: true,
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
//   useRdsProxy: cfg.useRdsProxy,
//   enableFlower: cfg.enableFlower,
//   clientAccess: { kind: 'prefixList', prefixListId: corpLaptopPrefixList.ref },
//   prometheusPeer: ec2.Peer.securityGroupId(prometheusSg.securityGroupId),
// });
// sgs.assertWorkerDbIsolation();
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
