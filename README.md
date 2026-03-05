```bash
# ---------------------------------------------------------------------------
# Fill in your migration command here
# ---------------------------------------------------------------------------
run_migration() {
  echo "run_migration() not implemented."
  return 1
}

# ---------------------------------------------------------------------------
# rds_migrate --instance-id <id> --region <region>
# ---------------------------------------------------------------------------
rds_migrate() {
  local instance_id="" region="" db_json="" snapshot_id=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --instance-id) instance_id="$2"; shift 2 ;;
      --region)      region="$2";      shift 2 ;;
      *) echo "Usage: rds_migrate --instance-id <id> --region <region>"; return 1 ;;
    esac
  done

  [[ -z "${instance_id}" ]] && { echo "--instance-id is required"; return 1; }
  [[ -z "${region}" ]]      && { echo "--region is required";      return 1; }

  command -v aws > /dev/null || { echo "aws CLI not found"; return 1; }
  command -v jq  > /dev/null || { echo "jq not found";     return 1; }

  snapshot_id="pre-migration-${instance_id}-$(date +%Y%m%d%H%M%S)"

  # --- Introspect ----------------------------------------------------------
  echo "Fetching instance config: ${instance_id}"
  db_json=$(aws rds describe-db-instances \
    --region "${region}" \
    --db-instance-identifier "${instance_id}" \
    --query 'DBInstances[0]' \
    --output json) || { echo "Could not describe instance '${instance_id}'"; return 1; }

  # --- Snapshot ------------------------------------------------------------
  echo "Creating snapshot: ${snapshot_id}"
  aws rds create-db-snapshot \
    --region "${region}" \
    --db-instance-identifier "${instance_id}" \
    --db-snapshot-identifier "${snapshot_id}" \
    --output text > /dev/null
  aws rds wait db-snapshot-available \
    --region "${region}" \
    --db-snapshot-identifier "${snapshot_id}"
  echo "Snapshot ready."

  # --- Migrate -------------------------------------------------------------
  set +e; run_migration; local exit_code=$?; set -e

  [[ ${exit_code} -eq 0 ]] && { echo "Migration succeeded."; return 0; }

  # --- Rollback ------------------------------------------------------------
  echo "Migration failed (exit ${exit_code}). Rolling back..."

  local deletion_protection
  deletion_protection=$(echo "${db_json}" | jq -r '.DeletionProtection')

  if [[ "${deletion_protection}" == "true" ]]; then
    aws rds modify-db-instance \
      --region "${region}" \
      --db-instance-identifier "${instance_id}" \
      --no-deletion-protection \
      --apply-immediately \
      --output text > /dev/null
    sleep 10
  fi

  aws rds delete-db-instance \
    --region "${region}" \
    --db-instance-identifier "${instance_id}" \
    --skip-final-snapshot \
    --output text > /dev/null
  aws rds wait db-instance-deleted \
    --region "${region}" \
    --db-instance-identifier "${instance_id}"
  echo "Instance deleted."

  # Build restore command from captured config
  local sg_ids
  sg_ids=$(echo "${db_json}" | jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")')

  local multi_az publicly_accessible auto_minor iops db_name option_group ca_cert timezone storage_encrypted kms_key
  multi_az=$(echo            "${db_json}" | jq -r '.MultiAZ')
  publicly_accessible=$(echo "${db_json}" | jq -r '.PubliclyAccessible')
  auto_minor=$(echo          "${db_json}" | jq -r '.AutoMinorVersionUpgrade')
  iops=$(echo                "${db_json}" | jq -r '.Iops // empty')
  db_name=$(echo             "${db_json}" | jq -r '.DBName // empty')
  option_group=$(echo        "${db_json}" | jq -r '.OptionGroupMemberships[0].OptionGroupName // empty')
  ca_cert=$(echo             "${db_json}" | jq -r '.CACertificateIdentifier // empty')
  timezone=$(echo            "${db_json}" | jq -r '.Timezone // empty')
  storage_encrypted=$(echo   "${db_json}" | jq -r '.StorageEncrypted')
  kms_key=$(echo             "${db_json}" | jq -r '.KmsKeyId // empty')

  local restore_cmd=(
    aws rds restore-db-instance-from-db-snapshot
    --region                  "${region}"
    --db-instance-identifier  "${instance_id}"
    --db-snapshot-identifier  "${snapshot_id}"
    --db-instance-class       "$(echo "${db_json}" | jq -r '.DBInstanceClass')"
    --db-subnet-group-name    "$(echo "${db_json}" | jq -r '.DBSubnetGroup.DBSubnetGroupName')"
    --vpc-security-group-ids  ${sg_ids}
    --engine-version          "$(echo "${db_json}" | jq -r '.EngineVersion')"
    --port                    "$(echo "${db_json}" | jq -r '.Endpoint.Port')"
    --license-model           "$(echo "${db_json}" | jq -r '.LicenseModel')"
    --storage-type            "$(echo "${db_json}" | jq -r '.StorageType')"
    --db-parameter-group-name "$(echo "${db_json}" | jq -r '.DBParameterGroups[0].DBParameterGroupName')"
    --output text
  )

  [[ "${multi_az}" == "true" ]]            && restore_cmd+=(--multi-az)                  || restore_cmd+=(--no-multi-az)
  [[ "${publicly_accessible}" == "true" ]] && restore_cmd+=(--publicly-accessible)       || restore_cmd+=(--no-publicly-accessible)
  [[ "${auto_minor}" == "true" ]]          && restore_cmd+=(--auto-minor-version-upgrade) || restore_cmd+=(--no-auto-minor-version-upgrade)
  [[ "${deletion_protection}" == "true" ]] && restore_cmd+=(--deletion-protection)       || restore_cmd+=(--no-deletion-protection)
  [[ -n "${iops}" ]]         && restore_cmd+=(--iops "${iops}")
  [[ -n "${db_name}" ]]      && restore_cmd+=(--db-name "${db_name}")
  [[ -n "${option_group}" ]] && restore_cmd+=(--option-group-name "${option_group}")
  [[ -n "${ca_cert}" ]]      && restore_cmd+=(--ca-certificate-identifier "${ca_cert}")
  [[ -n "${timezone}" ]]     && restore_cmd+=(--timezone "${timezone}")
  [[ "${storage_encrypted}" == "true" && -n "${kms_key}" ]] && restore_cmd+=(--kms-key-id "${kms_key}")

  echo "Restoring instance..."
  "${restore_cmd[@]}" > /dev/null
  aws rds wait db-instance-available \
    --region "${region}" \
    --db-instance-identifier "${instance_id}"

  # Re-apply tags
  local tags_json restored_arn
  tags_json=$(aws rds list-tags-for-resource \
    --region "${region}" \
    --resource-name "$(echo "${db_json}" | jq -r '.DBInstanceArn')" \
    --query 'TagList' --output json)
  restored_arn=$(aws rds describe-db-instances \
    --region "${region}" \
    --db-instance-identifier "${instance_id}" \
    --query 'DBInstances[0].DBInstanceArn' --output text)
  [[ "$(echo "${tags_json}" | jq 'length')" -gt 0 ]] && \
    aws rds add-tags-to-resource \
      --region "${region}" \
      --resource-name "${restored_arn}" \
      --tags "$(echo "${tags_json}" | jq -c '.')" \
      --output text > /dev/null

  echo "Rollback complete."
  return 1
}

# Run directly if executed as a script (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  rds_migrate "$@"
fi
```
