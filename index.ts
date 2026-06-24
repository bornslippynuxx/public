#!/usr/bin/env node
import { Command, Option } from "commander";
import { migrate, type Strategy } from "./commands/migrate";
import { airflowConfig } from "../lib/config";
import { AwsOps } from "./lib/aws-ops";

const program = new Command();

program
  .name("airflow-ops")
  .description("Application-level ops for the CDK-deployed Airflow on Fargate")
  .version("0.1.0");

// --- DB migration: data-plane only, never touches infra or image tag ---
program
  .command("migrate")
  .description("Run airflow db migrate against the metadata DB")
  .addOption(
    new Option("-s, --strategy <strategy>", "migration strategy (required)")
      .choices(["bluegreen", "snapshot"])
      .makeOptionMandatory(true), // no default: operator must choose
  )
  .option("--dry-run", "print the plan without making changes", false)
  .action(async (o) => {
    await migrate({ strategy: o.strategy as Strategy, dryRun: o.dryRun });
  });

// --- Generic one-off airflow command on the deployed image, gated on exit ---
async function runAirflow(cmd: string[]): Promise<never> {
  const ops = new AwsOps(airflowConfig);
  const tag = await ops.getImageTag();
  const { exitCode } = await ops.runOneOffTask({ imageTag: tag, command: cmd });
  console.log(`exit ${exitCode}`);
  process.exit(exitCode === 0 ? 0 : 1);
}

program
  .command("run <cmd...>")
  .description("Run an arbitrary airflow CLI command as a one-off task")
  .action(async (cmd: string[]) => {
    await runAirflow(["airflow", ...cmd]);
  });

program
  .command("db-clean")
  .description("Purge old metadata (airflow db clean) before a retention date")
  .requiredOption("--before <date>", "clean records older than this (YYYY-MM-DD)")
  .action(async (o) => {
    // db clean mutates shared metadata the live services use — but it's
    // application data, not infra. Gated like everything else.
    await runAirflow(["airflow", "db", "clean", "--clean-before-timestamp", o.before, "-y"]);
  });

program
  .command("pause <dag_id>")
  .description("Pause a DAG")
  .action(async (dagId: string) => {
    await runAirflow(["airflow", "dags", "pause", dagId]);
  });

program
  .command("unpause <dag_id>")
  .description("Unpause a DAG")
  .action(async (dagId: string) => {
    await runAirflow(["airflow", "dags", "unpause", dagId]);
  });

program
  .command("backfill <dag_id>")
  .description("Backfill a DAG over a date range")
  .requiredOption("--start <date>", "start date (YYYY-MM-DD)")
  .requiredOption("--end <date>", "end date (YYYY-MM-DD)")
  .action(async (dagId: string, o) => {
    await runAirflow([
      "airflow", "dags", "backfill",
      "--start-date", o.start,
      "--end-date", o.end,
      dagId,
    ]);
  });

program
  .command("version-info")
  .description("Print the currently-deployed image tag (read-only)")
  .action(async () => {
    const ops = new AwsOps(airflowConfig);
    console.log(await ops.getImageTag());
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
