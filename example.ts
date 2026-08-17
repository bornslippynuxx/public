/**
 * Instantiation example: platform + runtime.
 *
 * PLATFORM owns the RDS instance and the central log group. The instance
 * creates its own security group; the platform stack publishes its ID.
 *
 * RUNTIME owns the SG mesh and the Airflow services. It imports the RDS
 * security group as MUTABLE and adds the 5432 ingress rules itself, so every
 * rule in the mesh is synthesized in one stack and reviews in one place —
 * even though that one group is defined elsewhere.
 *
 * The VPC's interface endpoints are managed elsewhere and their SG admits the
 * VPC CIDR, so nothing here creates or references them.
 *
 * Dependency runs runtime -> platform, one direction. Nothing in platform
 * references a runtime SG, which is what keeps CloudFormation from seeing a
 * cycle.
 *
 * SSM parameters create no CloudFormation dependency, so deploy order is
 * declared explicitly at the bottom.
 */

import { App, Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AirflowSecurityGroups } from './airflow-security-groups';

interface EnvProps extends StackProps {
  readonly envName: string;
}

const paramPath = (env: string, leaf: string) => `/airflow/${env}/${leaf}`;

// ---------------------------------------------------------------------------
// 1. Platform — RDS and the central log group
// ---------------------------------------------------------------------------

export class AirflowPlatformStack extends Stack {
  constructor(scope: App, id: string, props: EnvProps & { multiAz: boolean }) {
    super(scope, id, props);
    const { envName } = props;

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcName: `${envName}-airflow` });

    // No securityGroups prop: the instance creates its own, and the runtime
    // stack adds the ingress rule to it.
    const db = new rds.DatabaseInstance(this, 'Db', {
      vpc,
      // The subnet group must span >= 2 AZs in EVERY env, including the ones
      // where multiAz is false. A single-AZ subnet group cannot be flipped to
      // Multi-AZ later without replacing the instance.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: props.multiAz,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
      deletionProtection: envName === 'prod',
      removalPolicy: envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'AirflowLogs', {
      logGroupName: `/airflow/${envName}`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const publish = (leaf: string, value: string) =>
      new ssm.StringParameter(this, `Param-${leaf.replace('/', '-')}`, {
        parameterName: paramPath(envName, leaf),
        stringValue: value,
      });

    // The SG the instance made for itself. Runtime imports this and attaches
    // the rule; nothing here needs to know who the clients are.
    publish('sg/rds', db.connections.securityGroups[0].securityGroupId);

    // Publish the log group ARN rather than letting runtime rebuild it from a
    // name — a rename then fails loudly instead of granting IAM on a log
    // group that no longer exists.
    publish('logs/arn', logGroup.logGroupArn);
    publish('db/endpoint', db.dbInstanceEndpointAddress);
  }
}

// ---------------------------------------------------------------------------
// 2. Runtime — SG mesh and services
// ---------------------------------------------------------------------------

export class AirflowRuntimeStack extends Stack {
  constructor(
    scope: App,
    id: string,
    props: EnvProps & { schedulerCount: number; uiClientCidrs: string[] },
  ) {
    super(scope, id, props);
    const { envName } = props;

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcName: `${envName}-airflow` });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // mutable: true is required and deliberate. The construct adds the 5432
    // ingress rule to this group, and because the import is scoped to THIS
    // stack, the rule is synthesized here — dependency runs runtime ->
    // platform. Importing it in the platform stack instead would reverse that
    // and produce a cycle.
    const rdsSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'RdsSg',
      ssm.StringParameter.valueForStringParameter(this, paramPath(envName, 'sg/rds')),
      { mutable: true },
    );

    const sgs = new AirflowSecurityGroups(this, 'Sgs', {
      vpc,
      envName,
      // One place per env. Tightening this later is a one-line change.
      uiClientCidrs: props.uiClientCidrs,
      // Prometheus discovers tasks via Cloud Map and connects to task IPs, so
      // the peer is the Prometheus host's SG, not a load balancer.
      prometheus: ec2.Peer.securityGroupId(
        ssm.StringParameter.valueForStringParameter(this, paramPath(envName, 'sg/prometheus')),
      ),
      rds: rdsSg,
    });

    const logGroup = logs.LogGroup.fromLogGroupArn(
      this,
      'Logs',
      ssm.StringParameter.valueForStringParameter(this, paramPath(envName, 'logs/arn')),
    );

    const service = (
      name: string,
      taskDefinition: ecs.FargateTaskDefinition,
      securityGroup: ec2.ISecurityGroup,
      desiredCount: number,
    ) =>
      new ecs.FargateService(this, name, {
        cluster,
        taskDefinition,
        desiredCount,
        // Omit securityGroups and CDK silently creates its own with open
        // egress, which defeats the mesh entirely.
        securityGroups: [securityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        circuitBreaker: { rollback: true },
        healthCheckGracePeriod: Duration.seconds(120),
      });

    // Declared for illustration — build these from your image, with awslogs
    // pointed at `logGroup`.
    declare const apiServerTask: ecs.FargateTaskDefinition;
    declare const schedulerTask: ecs.FargateTaskDefinition;
    declare const dagProcessorTask: ecs.FargateTaskDefinition;
    declare const triggererTask: ecs.FargateTaskDefinition;
    declare const workerTask: ecs.FargateTaskDefinition;

    service('ApiServer', apiServerTask, sgs.api, 2);
    service('Scheduler', schedulerTask, sgs.scheduler, props.schedulerCount);
    service('DagProcessor', dagProcessorTask, sgs.dagProcessor, 1);
    service('Triggerer', triggererTask, sgs.triggerer, 2);
    service('Worker', workerTask, sgs.worker, 4);

    // One-shot migrations run on sgs.manualTask, not a service:
    //   new tasks.EcsRunTask(this, 'DbMigrate', {
    //     securityGroups: [sgs.manualTask],
    //     launchTarget: new tasks.EcsFargateLaunchTarget(),
    //   });

    void logGroup;
  }
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

const app = new App();
const envName = app.node.tryGetContext('env') ?? 'staging';
const isUpper = envName !== 'dev';

const platform = new AirflowPlatformStack(app, `${envName}-airflow-platform`, {
  envName,
  multiAz: isUpper,
});

const runtime = new AirflowRuntimeStack(app, `${envName}-airflow-runtime`, {
  envName,
  schedulerCount: isUpper ? 2 : 1,
  // Broad for now, matching what the shared group already permitted. Narrow
  // once a customer-managed prefix list for the operator ranges exists.
  uiClientCidrs: ['10.0.0.0/8'],
});

// SSM parameters create no CloudFormation dependency, so ordering is declared
// here. Without this line runtime can deploy first and fail while adding an
// ingress rule to a security group that does not exist yet.
runtime.addDependency(platform);
