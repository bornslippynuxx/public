# Airflow Version Upgrades & Diaaster Recovery

# Overview

Airflow deployments in non-feature environments(dev/qa/stage/prod) will shift to follow a "Immutable Versioned Environment" strategy:

1. in dev/qa/stage/prod, airflow-infra deployment will only be triggered by pushing a tag to the correct branch
2. once a tag is pushed, a pipeline will kick off to setup a brand new environment from scratch
3. a set of manual/automated pipelines will be used to:
   1. setup/remove a maintenance page on the current airflow deployment
   2. backup/restore an RDS DB
   3. manage http traffic between old/new versions
   4. stop/start ECS tasks as Required

https://medium.com/@ankur_chawla/immutable-architectures-on-aws-revolutionizing-deployment-strategies-2f2c71c5004e
https://medium.com/@eren.c.uysal/immutable-infrastructure-and-blue-green-deployment-strategies-b481527c13f3

## Version Upgrade

Airflow Version upgrades are planned events that require:

- code changes
- data migrations
- downtime

### Workflow

The High level steps that need to be performed to upgrade a the airflow version is as follows:

1. create new image(s) as required in airflow-images
2. create a feature environment (airflow-infra/airflow-dags)to perform a test upgrade with these new images
3. make any any neccessary modifications to CDK code to support the new env (ex. new Postgres version, different airflow env variables etc)
4. once the version upgrade has been shown to work in the feature env
   1. merges changes to develop
   2. tag develop with version (ex "2.12.2), this will trigger a new env creation
5. Once the pipeline completes, you will have a new 2.12.2 environment ready to setup
6. Perform the steps outlined in the next section to migrate data from the pre-existing env to new environement

### Upgrade Steps

Upgrading Airflow from OLD to NEW will require a breif outage during which we:

1. start a maintanance window
2. setup NEW env
3. validate new env
4. route OLD DNS to NEW

Note: the OLD env should be destroyed after NEW has been in Production for a few days

#### Maintenance Window - Start

1. (via Airflow) pause all dags on OLD
2. (via Manual/Automated Pipeline) block all webserver traffic to airflow OLD (Maintenance page)
3. (via Manual/Automated Pipeline) stop all ECS Fargate Tasks on OLD
4. (via Manual/Automated Pipeline) stop all ECS Fargate Tasks on NEW
5. (via Manual/Automated Pipeline) take snapshot of OLD DB
6. (via Manual/Automated Pipeline) restore snapshot of OLD DB on NEW RDS
7. (via Manual/Automated Pipeline) run dbMigrate on NEW RDS
8. (via Manual/Automated Pipeline) start all ECS Fargate Tasks on NEW

#### Maintenance Window - Validate NEW

The newly setup environment should be fully available and working on https://airflow-NEW.xxx.yyy.pvt
Users should access the new version and ensure Dags are working

#### Maintenance Window - End

1. (via Airflow) unpause all dags on NEW
2. (via Manual/Automated Pipeline) change DNS point https://airflow.xxx.yyy.pvt -> https://airflow-NEW.xxx.yyy.pvt
3. (via Manual/Automated Pipeline) on NEW allow all webserver traffic to airflow (remove Maintenance page)

## Disaster Recovery

Airflow Disaster Recevery are unplanned events that require restoration to the last known working version.

### Workflow

The High level steps that need to be performed to recover an airflow version is as follows:

1. ascertain what caused the airflow system to go down
2. restore airflow to the last known working version

### Diaster Recovery Steps

Restoring Airflow will require:

1. (via Manual/Automated Pipeline) block all webserver traffic to airflow OLD (Maintenance page)
2. tag production with completely NEW version (ex "2.12.2-a"), this will trigger a new env creation
3. (via Manual Pipeline) stop all ECS Fargate Tasks on NEW
4. (via Manual Pipeline) restore snapshot of OLD DB on NEW RDS
5. (via Manual Pipeline) start all ECS Fargate Tasks on NEW
6. validate newly setup environment on https://airflow-NEW.xxx.yyy.pvt
7. (via Manual/Automated Pipeline) change DNS point https://airflow.xxx.yyy.pvt -> https://airflow-NEW.xxx.yyy.pvt
8. (via Manual/Automated Pipeline) on NEW allow all webserver traffic to airflow (remove Maintenance page)

# Required changes

## CDK changes

1. Enable cross region backups replication on the Postgres RDS DB to all 3 us-gov-west AZs
2. In order to not lose logs accross version upgrades, move the existing AirflowLogGroup into it's own stack (in the same project), export logArn and reference in existing stack
3. all AWS stack resources should be postfixed with branch tag (i.e version number)
4. change all DNS to be postfixed with version (ex. airflow-VERSION.xxx.yyy.pvt)

## Pipeline changes

1. in named envs, the stack deploy should only be triggered by pushing a tag
2. create the following pipeline jobs
   - backup DB (DBInstanceID)
   - restore DB (snapshotARN, destDBInstanceID)
   - setup maintenance Page
   - remove maintenance Page
   - stop all ECS Tasks
   - start all ECS Tasks
   - set DNS
3. Ensure that pipelines/jobs for named envs ae secured by gitlab role-based access

