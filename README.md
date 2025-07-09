demo

```
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface AirflowSecurityGroupsProps {
  vpc: ec2.IVpc;
  // Optional: if you want to allow access from specific CIDR blocks
  allowedCidrs?: string[];
  // Optional: if you want to allow access from specific security groups
  allowedSecurityGroups?: ec2.ISecurityGroup[];
}

export class AirflowSecurityGroups extends Construct {
  public readonly webserverSecurityGroup: ec2.SecurityGroup;
  public readonly schedulerSecurityGroup: ec2.SecurityGroup;
  public readonly workerSecurityGroup: ec2.SecurityGroup;
  public readonly rdsSecurityGroup: ec2.SecurityGroup;
  public readonly redisSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AirflowSecurityGroupsProps) {
    super(scope, id);

    const { vpc, allowedCidrs = [], allowedSecurityGroups = [] } = props;

    // Application Load Balancer Security Group
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AirflowALBSecurityGroup', {
      vpc,
      description: 'Security group for Airflow Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow HTTP and HTTPS traffic from specified CIDRs or from internet
    const httpsCidrs = allowedCidrs.length > 0 ? allowedCidrs : ['0.0.0.0/0'];
    httpsCidrs.forEach(cidr => {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(80),
        'Allow HTTP access'
      );
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        'Allow HTTPS access'
      );
    });

    // Allow access from specified security groups
    allowedSecurityGroups.forEach(sg => {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(sg.securityGroupId),
        ec2.Port.tcp(80),
        'Allow HTTP access from security group'
      );
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(sg.securityGroupId),
        ec2.Port.tcp(443),
        'Allow HTTPS access from security group'
      );
    });

    // Airflow Webserver Security Group
    this.webserverSecurityGroup = new ec2.SecurityGroup(this, 'AirflowWebserverSecurityGroup', {
      vpc,
      description: 'Security group for Airflow Webserver',
      allowAllOutbound: true,
    });

    // Allow traffic from ALB to webserver
    this.webserverSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
      ec2.Port.tcp(8080),
      'Allow traffic from ALB to webserver'
    );

    // Airflow Scheduler Security Group
    this.schedulerSecurityGroup = new ec2.SecurityGroup(this, 'AirflowSchedulerSecurityGroup', {
      vpc,
      description: 'Security group for Airflow Scheduler',
      allowAllOutbound: true,
    });

    // Airflow Worker Security Group
    this.workerSecurityGroup = new ec2.SecurityGroup(this, 'AirflowWorkerSecurityGroup', {
      vpc,
      description: 'Security group for Airflow Workers',
      allowAllOutbound: true,
    });

    // RDS Security Group
    this.rdsSecurityGroup = new ec2.SecurityGroup(this, 'AirflowRDSSecurityGroup', {
      vpc,
      description: 'Security group for Airflow RDS database',
      allowAllOutbound: false, // RDS typically doesn't need outbound access
    });

    // Allow PostgreSQL access from Airflow components
    [this.webserverSecurityGroup, this.schedulerSecurityGroup, this.workerSecurityGroup].forEach(sg => {
      this.rdsSecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(sg.securityGroupId),
        ec2.Port.tcp(5432),
        `Allow PostgreSQL access from ${sg.node.id}`
      );
    });

    // Redis Security Group (ElastiCache)
    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'AirflowRedisSecurityGroup', {
      vpc,
      description: 'Security group for Airflow Redis/ElastiCache',
      allowAllOutbound: false, // Redis typically doesn't need outbound access
    });

    // Allow Redis access from Airflow components
    [this.webserverSecurityGroup, this.schedulerSecurityGroup, this.workerSecurityGroup].forEach(sg => {
      this.redisSecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(sg.securityGroupId),
        ec2.Port.tcp(6379),
        `Allow Redis access from ${sg.node.id}`
      );
    });

    // Allow internal communication between Airflow components
    // This is important for distributed deployments
    this.allowInternalCommunication();

    // Tag all security groups for easier management
    this.tagSecurityGroups();
  }

  private allowInternalCommunication(): void {
    const airflowComponents = [
      this.webserverSecurityGroup,
      this.schedulerSecurityGroup,
      this.workerSecurityGroup,
    ];

    // Allow communication between all Airflow components
    airflowComponents.forEach(sourceSG => {
      airflowComponents.forEach(targetSG => {
        if (sourceSG !== targetSG) {
          targetSG.addIngressRule(
            ec2.Peer.securityGroupId(sourceSG.securityGroupId),
            ec2.Port.allTraffic(),
            `Allow internal communication from ${sourceSG.node.id}`
          );
        }
      });
    });

    // Allow self-referencing rules for each component (for clustering/scaling)
    airflowComponents.forEach(sg => {
      sg.addIngressRule(
        ec2.Peer.securityGroupId(sg.securityGroupId),
        ec2.Port.allTraffic(),
        'Allow internal communication within same component'
      );
    });
  }

  private tagSecurityGroups(): void {
    const securityGroups = [
      { sg: this.albSecurityGroup, component: 'ALB' },
      { sg: this.webserverSecurityGroup, component: 'Webserver' },
      { sg: this.schedulerSecurityGroup, component: 'Scheduler' },
      { sg: this.workerSecurityGroup, component: 'Worker' },
      { sg: this.rdsSecurityGroup, component: 'RDS' },
      { sg: this.redisSecurityGroup, component: 'Redis' },
    ];

    securityGroups.forEach(({ sg, component }) => {
      cdk.Tags.of(sg).add('Component', component);
      cdk.Tags.of(sg).add('Service', 'Airflow');
      cdk.Tags.of(sg).add('Environment', 'production'); // Adjust as needed
    });
  }

  // Helper method to add custom rules if needed
  public addCustomRule(
    securityGroup: ec2.SecurityGroup,
    peer: ec2.IPeer,
    port: ec2.Port,
    description: string
  ): void {
    securityGroup.addIngressRule(peer, port, description);
  }
}

// Usage example in your main stack
export class AirflowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Assuming you have a VPC already created
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVPC', {
      vpcId: 'vpc-xxxxxxxxx', // Replace with your VPC ID
    });

    // Create security groups
    const securityGroups = new AirflowSecurityGroups(this, 'AirflowSecurityGroups', {
      vpc,
      // Optional: restrict access to specific IP ranges
      allowedCidrs: [
        '10.0.0.0/8',    // Private networks
        '172.16.0.0/12', // Private networks
        '192.168.0.0/16', // Private networks
        // Add your office/home IP ranges here
      ],
    });

    // Output the security group IDs for reference
    new cdk.CfnOutput(this, 'WebserverSecurityGroupId', {
      value: securityGroups.webserverSecurityGroup.securityGroupId,
      description: 'Security Group ID for Airflow Webserver',
    });

    new cdk.CfnOutput(this, 'SchedulerSecurityGroupId', {
      value: securityGroups.schedulerSecurityGroup.securityGroupId,
      description: 'Security Group ID for Airflow Scheduler',
    });

    new cdk.CfnOutput(this, 'WorkerSecurityGroupId', {
      value: securityGroups.workerSecurityGroup.securityGroupId,
      description: 'Security Group ID for Airflow Workers',
    });

    new cdk.CfnOutput(this, 'RDSSecurityGroupId', {
      value: securityGroups.rdsSecurityGroup.securityGroupId,
      description: 'Security Group ID for RDS Database',
    });

    new cdk.CfnOutput(this, 'RedisSecurityGroupId', {
      value: securityGroups.redisSecurityGroup.securityGroupId,
      description: 'Security Group ID for Redis/ElastiCache',
    });

    new cdk.CfnOutput(this, 'ALBSecurityGroupId', {
      value: securityGroups.albSecurityGroup.securityGroupId,
      description: 'Security Group ID for Application Load Balancer',
    });
  }
}
```
