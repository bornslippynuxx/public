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
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { AirflowSecurityGroups } from './airflow-security-groups';

interface EnvProps extends StackProps {
  readonly envName: string;
}

const paramPath = (env: string, leaf: string) => `/airflow/${env}/${leaf}`;

// ---------------------------------------------------------------------------
// 1. Platform — RDS and the central log group
// ---------------------------------------------------------------------------

export class AirflowPlatformStack extends Stack {
  constructor(
    scope: App,
    id: string,
    props: EnvProps & { multiAz: boolean; certificateArn: string },
  ) {
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

    // Public ALB. No securityGroups prop — it creates its own, and the runtime
    // stack adds the client ingress rules to it.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // The redirect is a listener action, so port 80 has to be reachable for it
    // to fire. The matching SG rule is added in the runtime stack alongside
    // the 443 rule.
    alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Default action is a placeholder: the api-server target group lives in
    // the runtime stack, which imports this listener and adds the rule that
    // routes to it.
    const httpsListener = alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'airflow api-server not registered',
      }),
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

    // The group the ALB made for itself. Runtime imports this mutable and
    // writes the client rules onto it.
    publish('sg/alb', alb.connections.securityGroups[0].securityGroupId);
    publish('alb/https-listener-arn', httpsListener.listenerArn);
  }
}

// ---------------------------------------------------------------------------
// 2. Runtime — SG mesh and services
// ---------------------------------------------------------------------------

export class AirflowRuntimeStack extends Stack {
  constructor(
    scope: App,
    id: string,
    props: EnvProps & { schedulerCount: number },
  ) {
    super(scope, id, props);
    const { envName } = props;

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcName: `${envName}-airflow` });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const isLowerEnv = envName === 'dev';

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
      // The platform ALB's group. mutable: true — the construct writes the
      // client ingress rules onto it from here.
      alb: ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'AlbSg',
        ssm.StringParameter.valueForStringParameter(this, paramPath(envName, 'sg/alb')),
        { mutable: true },
      ),
      uiClients: ec2.Peer.ipv4('10.0.0.0/8'),
      // Prometheus connects to task IPs directly, so the peer is the
      // Prometheus host's SG, not a load balancer.
      prometheus: ec2.Peer.securityGroupId(
        ssm.StringParameter.valueForStringParameter(this, paramPath(envName, 'sg/prometheus')),
      ),
      rds: rdsSg,
      // Lower envs front the redis container with an NLB; upper envs talk to
      // ElastiCache directly. The construct creates the NLB's group, which is
      // handed to the NLB at creation below.
      redisViaNlb: isLowerEnv,
    });

    // if (isLowerEnv) {
    //   const redisNlb = new elbv2.NetworkLoadBalancer(this, 'RedisNlb', {
    //     vpc,
    //     internetFacing: false,
    //     vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    //     securityGroups: [sgs.redisNlb!], // creation-time only
    //   });
    //   ...listener + redisService.registerLoadBalancerTargets(...)
    // }

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

    // Keep whatever service discovery / load balancer wiring you already
    // have. Only the securityGroups argument changes in this refactor.
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
  certificateArn: app.node.tryGetContext('certificateArn'),
});

const runtime = new AirflowRuntimeStack(app, `${envName}-airflow-runtime`, {
  envName,
  schedulerCount: isUpper ? 2 : 1,
});

// SSM parameters create no CloudFormation dependency, so ordering is declared
// here. Without this line runtime can deploy first and fail while adding an
// ingress rule to a security group that does not exist yet.
runtime.addDependency(platform);
