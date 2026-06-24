/**
 * Single source of truth for resource names/ARNs.
 *
 * CDK consumes this at synth time to NAME resources.
 * The CLI consumes the same object at runtime to FIND them.
 * Because both import this file, there is no drift between
 * what CloudFormation deploys and what the CLI targets.
 *
 * The version is intentionally NOT hardcoded here — it lives in
 * SSM Parameter Store so the CLI can read/bump it without a code change.
 */
export interface AirflowConfig {
  region: string;
  clusterName: string;
  /** Long-running ECS services keyed by logical role. */
  services: {
    webserver: string;
    scheduler: string;
    worker?: string; // present only for CeleryExecutor; omit for others
  };
  /** Task definition family for the one-off maintenance/migrate task. */
  maintenanceTaskFamily: string;
  /** Container name inside the maintenance task def (for overrides). */
  maintenanceContainerName: string;
  /** Networking for RunTask (awsvpc mode). */
  network: {
    subnetIds: string[];
    securityGroupIds: string[];
    assignPublicIp: boolean;
  };
  /** SSM parameter holding the currently desired Airflow image tag. */
  imageTagParam: string;
  /** ECR repo URI (without tag) for the Airflow image. */
  ecrRepoUri: string;
  /** RDS instance identifier for the Airflow metadata DB (snapshot path). */
  dbInstanceIdentifier: string;
}

export const airflowConfig: AirflowConfig = {
  region: "us-east-1",
  clusterName: "airflow-cluster",
  services: {
    webserver: "airflow-webserver",
    scheduler: "airflow-scheduler",
    worker: "airflow-worker",
  },
  maintenanceTaskFamily: "airflow-maintenance",
  maintenanceContainerName: "airflow",
  network: {
    subnetIds: ["subnet-aaaa1111", "subnet-bbbb2222"],
    securityGroupIds: ["sg-cccc3333"],
    assignPublicIp: false,
  },
  imageTagParam: "/airflow/image-tag",
  ecrRepoUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/airflow",
  dbInstanceIdentifier: "airflow-metadata-db",
};
