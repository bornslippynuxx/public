import { airflowConfig } from "../../lib/config";
import { AwsOps } from "../lib/aws-ops";

/**
 * Airflow metadata DB migration. This is a DATA-PLANE operation, not infra.
 * It does NOT change the deployed image tag and does NOT roll services —
 * that is the job of CDK/GitLab. This command only runs `airflow db migrate`
 * against the metadata DB, with the safety sequencing the two strategies need.
 *
 * Strategy is OPERATOR-ASSERTED (we can't verify backwards-compatibility),
 * so there is no default: the operator must choose, and the unsafe-looking
 * choice (bluegreen, no snapshot) announces exactly what it assumes.
 */
export type Strategy = "bluegreen" | "snapshot";

export interface MigrateOptions {
  strategy: Strategy;
  dryRun?: boolean;
  migrateTimeoutSec?: number;
}

export async function migrate(opts: MigrateOptions): Promise<void> {
  const cfg = airflowConfig;
  const ops = new AwsOps(cfg);
  const tag = await ops.getImageTag(); // run against the DEPLOYED image

  if (opts.strategy === "bluegreen") {
    await migrateBlueGreen(ops, cfg, tag, opts);
  } else {
    await migrateWithSnapshot(ops, cfg, tag, opts);
  }
}

/**
 * Backwards-COMPATIBLE schema change. Old services can keep running against
 * the migrated schema, so we migrate live with zero downtime — no snapshot,
 * no scale-down. The correctness of this path rests ENTIRELY on the operator's
 * compatibility assertion, so we say so out loud.
 */
async function migrateBlueGreen(
  ops: AwsOps,
  cfg: typeof airflowConfig,
  tag: string,
  opts: MigrateOptions,
): Promise<void> {
  console.log("Strategy: BLUE/GREEN (operator asserts backwards-compatible)");
  console.warn(
    "  WARNING: proceeding WITHOUT a snapshot and WITHOUT scaling down.\n" +
      "  Live schedulers/webservers will run against the migrated schema.\n" +
      "  If this schema change is NOT backwards-compatible, abort now (Ctrl-C)\n" +
      "  and re-run with --strategy snapshot.",
  );

  if (opts.dryRun) {
    console.log(`[dry-run] would run \`airflow db migrate\` on image tag ${tag}`);
    return;
  }

  const { exitCode } = await ops.runOneOffTask({
    imageTag: tag,
    command: ["airflow", "db", "migrate"],
    timeoutSec: opts.migrateTimeoutSec ?? 1800,
  });
  if (exitCode !== 0) {
    throw new Error(
      `db migrate failed (exit ${exitCode}). Services were NOT scaled down, ` +
        `so they are still live on the pre-migrate schema. Check the migrate ` +
        `task logs. If the migration partially applied, you may need to restore ` +
        `from your most recent automated RDS backup.`,
    );
  }
  console.log("db migrate OK. Services continue running; no cutover needed.");
}

/**
 * Non-compatible schema change. Old services must NOT touch the new schema,
 * so we: capture desired counts -> scale all services to 0 -> snapshot ->
 * migrate -> ALWAYS restore counts (finally). Downtime spans scale-down to
 * restore. The snapshot is the rollback point and its id is logged.
 */
async function migrateWithSnapshot(
  ops: AwsOps,
  cfg: typeof airflowConfig,
  tag: string,
  opts: MigrateOptions,
): Promise<void> {
  console.log("Strategy: SNAPSHOT + DOWNTIME (non-compatible schema change)");

  const services = Object.values(cfg.services).filter(
    (s): s is string => Boolean(s),
  );

  if (opts.dryRun) {
    console.log(`[dry-run] would capture desired counts for: ${services.join(", ")}`);
    console.log(`[dry-run] would scale all to 0, snapshot ${cfg.dbInstanceIdentifier},`);
    console.log(`[dry-run] run db migrate on tag ${tag}, then restore counts.`);
    return;
  }

  // Capture BEFORE we touch anything, so restore is always possible.
  const original = await ops.getDesiredCounts(services);
  console.log("Captured desired counts:", original);

  let scaledDown = false;
  try {
    // Quiesce: nothing reads/writes the DB during migrate.
    console.log("Scaling all services to 0...");
    for (const s of services) {
      await ops.scaleService({ service: s, desiredCount: 0 });
    }
    scaledDown = true;
    console.log("All services at 0. DB is quiet.");

    // Snapshot must reach `available` BEFORE migrate begins.
    console.log("Creating RDS snapshot (rollback point)...");
    const snapshotId = await ops.snapshotDb({
      dbInstanceIdentifier: cfg.dbInstanceIdentifier,
      label: `pre-migrate-${tag}`,
    });
    console.log(`Snapshot available: ${snapshotId}`);
    console.log(`  ROLLBACK: restore this snapshot if migrate fails badly.`);

    // Migrate against the quiet DB.
    console.log("Running `airflow db migrate`...");
    const { exitCode } = await ops.runOneOffTask({
      imageTag: tag,
      command: ["airflow", "db", "migrate"],
      timeoutSec: opts.migrateTimeoutSec ?? 1800,
    });
    if (exitCode !== 0) {
      throw new Error(
        `db migrate failed (exit ${exitCode}). DB may be partially migrated. ` +
          `Rollback point: snapshot ${snapshotId}. Services will be restored ` +
          `to their original counts, but DO NOT resume normal ops until you ` +
          `decide whether to restore the snapshot.`,
      );
    }
    console.log("db migrate OK.");
  } finally {
    // ALWAYS restore — even on failure — so we never leave everything at 0.
    if (scaledDown) {
      console.log("Restoring services to original desired counts...");
      for (const [service, desiredCount] of Object.entries(original)) {
        try {
          await ops.scaleService({ service, desiredCount });
          console.log(`  ${service} -> ${desiredCount}`);
        } catch (e) {
          console.error(
            `  FAILED to restore ${service} to ${desiredCount}: ` +
              `${e instanceof Error ? e.message : String(e)}\n` +
              `  Restore it manually: aws ecs update-service --cluster ` +
              `${cfg.clusterName} --service ${service} --desired-count ${desiredCount}`,
          );
        }
      }
    }
  }

  console.log("\nMigrate complete. Services restored.");
}
