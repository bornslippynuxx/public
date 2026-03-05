```bash
# =============================================================================
# rds_migrate.sh
#
# Source this file into any existing bash script, then call:
#
#   rds_migrate --instance-id <id> --region <region>
#
# All other functions are private (prefixed _rds_) and not intended to be
# called directly.
#
# Prerequisites: AWS CLI v2 + jq
#
# REQUIRED IAM PERMISSIONS:
# {
#   "Version": "2012-10-17",
#   "Statement": [{
#     "Effect": "Allow",
#     "Action": [
#       "rds:DescribeDBInstances",
#       "rds:ListTagsForResource",
#       "rds:CreateDBSnapshot",
#       "rds:DescribeDBSnapshots",
#       "rds:ModifyDBInstance",
#       "rds:DeleteDBInstance",
#       "rds:RestoreDBInstanceFromDBSnapshot",
#       "rds:AddTagsToResource"
#     ],
#     "Resource": "*"
#   }]
# }
# =============================================================================

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_rds_info()    { echo "[INFO]  $(date '+%H:%M:%S') $*"; }
_rds_success() { echo "[OK]    $(date '+%H:%M:%S') $*"; }
_rds_warn()    { echo "[WARN]  $(date '+%H:%M:%S') $*" >&2; }
_rds_error()   { echo "[ERROR] $(date '+%H:%M:%S') $*" >&2; }
_rds_die()     { _rds_error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Introspect and cache the full instance description
# ---------------------------------------------------------------------------
_rds_fetch_instance_config() {
  _rds_info "Introspecting RDS instance: ${_RDS_INSTANCE_ID}"

  _RDS_DB_JSON=$(aws rds describe-db-instances \
    --region "${_RDS_REGION}" \
    --db-instance-identifier "${_RDS_INSTANCE_ID}" \
    --query 'DBInstances[0]' \
    --output json) || _rds_die "Could not describe '${_RDS_INSTANCE_ID}'. Check the ID and your AWS credentials."

  local status
  status=$(echo "${_RDS_DB_JSON}" | jq -r '.DBInstanceStatus')
  [[ "${status}" == "available" ]] || \
    _rds_warn "Instance status is '${status}' (expected 'available') — proceeding anyway."

  _rds_success "Instance found. Engine: $(echo "${_RDS_DB_JSON}" | jq -r '.Engine') \
$(echo "${_RDS_DB_JSON}" | jq -r '.EngineVersion'), \
Class: $(echo "${_RDS_DB_JSON}" | jq -r '.DBInstanceClass'), \
AZ: $(echo "${_RDS_DB_JSON}" | jq -r '.AvailabilityZone')"
}

# ---------------------------------------------------------------------------
# Create snapshot and wait until available
# ---------------------------------------------------------------------------
_rds_create_snapshot() {
  _rds_info "Creating snapshot: ${_RDS_SNAPSHOT_ID}"

  aws rds create-db-snapshot \
    --region "${_RDS_REGION}" \
    --db-instance-identifier "${_RDS_INSTANCE_ID}" \
    --db-snapshot-identifier "${_RDS_SNAPSHOT_ID}" \
    --output text > /dev/null

  _rds_info "Waiting for snapshot to become available (may take several minutes)..."
  aws rds wait db-snapshot-available \
    --region "${_RDS_REGION}" \
    --db-snapshot-identifier "${_RDS_SNAPSHOT_ID}"

  _rds_success "Snapshot ready: ${_RDS_SNAPSHOT_ID}"
}

# ---------------------------------------------------------------------------
# YOUR MIGRATION — replace the body with your real command
# ---------------------------------------------------------------------------
run_migration() {
  _rds_info "Running database migration..."

  # -------------------------------------------------------------------------
  # TODO: replace with your migration command, e.g.:
  #
  #   PGPASSWORD="${DB_PASSWORD}" psql \
  #     -h "${DB_HOST}" -U "${DB_USER}" -d "${DB_NAME}" \
  #     -f migrations/latest.sql
  #
  #   python manage.py migrate          # Django
  #   npx sequelize-cli db:migrate      # Sequelize
  #   flyway migrate                    # Flyway
  #   liquibase update                  # Liquibase
  # -------------------------------------------------------------------------

  _rds_die "run_migration() not implemented. Edit this function before running."
}

# ---------------------------------------------------------------------------
# Rollback — delete broken instance, restore from snapshot with original config
# ---------------------------------------------------------------------------
_rds_rollback() {
  _rds_warn "Migration failed — starting rollback."

  local db_class engine_version multi_az publicly_accessible storage_type
  local iops subnet_group db_name port license_model auto_minor deletion_protection
  local sg_ids param_group option_group_name ca_cert timezone storage_encrypted kms_key

  db_class=$(echo             "${_RDS_DB_JSON}" | jq -r '.DBInstanceClass')
  engine_version=$(echo       "${_RDS_DB_JSON}" | jq -r '.EngineVersion')
  multi_az=$(echo             "${_RDS_DB_JSON}" | jq -r '.MultiAZ')
  publicly_accessible=$(echo  "${_RDS_DB_JSON}" | jq -r '.PubliclyAccessible')
  storage_type=$(echo         "${_RDS_DB_JSON}" | jq -r '.StorageType')
  iops=$(echo                 "${_RDS_DB_JSON}" | jq -r '.Iops // empty')
  subnet_group=$(echo         "${_RDS_DB_JSON}" | jq -r '.DBSubnetGroup.DBSubnetGroupName')
  db_name=$(echo              "${_RDS_DB_JSON}" | jq -r '.DBName // empty')
  port=$(echo                 "${_RDS_DB_JSON}" | jq -r '.Endpoint.Port')
  license_model=$(echo        "${_RDS_DB_JSON}" | jq -r '.LicenseModel')
  auto_minor=$(echo           "${_RDS_DB_JSON}" | jq -r '.AutoMinorVersionUpgrade')
  deletion_protection=$(echo  "${_RDS_DB_JSON}" | jq -r '.DeletionProtection')
  ca_cert=$(echo              "${_RDS_DB_JSON}" | jq -r '.CACertificateIdentifier // empty')
  timezone=$(echo             "${_RDS_DB_JSON}" | jq -r '.Timezone // empty')
  storage_encrypted=$(echo    "${_RDS_DB_JSON}" | jq -r '.StorageEncrypted')
  kms_key=$(echo              "${_RDS_DB_JSON}" | jq -r '.KmsKeyId // empty')
  sg_ids=$(echo               "${_RDS_DB_JSON}" | jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")')
  param_group=$(echo          "${_RDS_DB_JSON}" | jq -r '.DBParameterGroups[0].DBParameterGroupName')
  option_group_name=$(echo    "${_RDS_DB_JSON}" | jq -r '.OptionGroupMemberships[0].OptionGroupName // empty')

  local tags_json
  tags_json=$(aws rds list-tags-for-resource \
    --region "${_RDS_REGION}" \
    --resource-name "$(echo "${_RDS_DB_JSON}" | jq -r '.DBInstanceArn')" \
    --query 'TagList' \
    --output json)

  _rds_info "Restoring with:"
  _rds_info "  Class           : ${db_class}"
  _rds_info "  Engine version  : ${engine_version}"
  _rds_info "  Storage         : ${storage_type}${iops:+ iops=${iops}}"
  _rds_info "  Multi-AZ        : ${multi_az}"
  _rds_info "  Subnet group    : ${subnet_group}"
  _rds_info "  Security groups : ${sg_ids}"
  _rds_info "  Parameter group : ${param_group}"
  _rds_info "  Encrypted       : ${storage_encrypted}${kms_key:+ (${kms_key})}"

  if [[ "${deletion_protection}" == "true" ]]; then
    _rds_info "Temporarily disabling deletion protection..."
    aws rds modify-db-instance \
      --region "${_RDS_REGION}" \
      --db-instance-identifier "${_RDS_INSTANCE_ID}" \
      --no-deletion-protection \
      --apply-immediately \
      --output text > /dev/null
    sleep 10
  fi

  _rds_info "Deleting broken instance: ${_RDS_INSTANCE_ID}"
  aws rds delete-db-instance \
    --region "${_RDS_REGION}" \
    --db-instance-identifier "${_RDS_INSTANCE_ID}" \
    --skip-final-snapshot \
    --output text > /dev/null

  _rds_info "Waiting for deletion to complete..."
  aws rds wait db-instance-deleted \
    --region "${_RDS_REGION}" \
    --db-instance-identifier "${_RDS_INSTANCE_ID}"
  _rds_success "Old instance deleted."

  local restore_cmd=(
    aws rds restore-db-instance-from-db-snapshot
    --region                   "${_RDS_REGION}"
    --db-instance-identifier   "${_RDS_INSTANCE_ID}"
    --db-snapshot-identifier   "${_RDS_SNAPSHOT_ID}"
    --db-instance-class        "${db_class}"
    --db-subnet-group-name     "${subnet_group}"
    --vpc-security-group-ids   ${sg_ids}        # intentionally unquoted (space-split)
    --engine-version           "${engine_version}"
    --port                     "${port}"
    --license-model            "${license_model}"
    --storage-type             "${storage_type}"
    --db-parameter-group-name  "${param_group}"
    --output text
  )

  [[ "${multi_az}" == "true" ]]            && restore_cmd+=(--multi-az)                   || restore_cmd+=(--no-multi-az)
  [[ "${publicly_accessible}" == "true" ]] && restore_cmd+=(--publicly-accessible)        || restore_cmd+=(--no-publicly-accessible)
  [[ "${auto_minor}" == "true" ]]          && restore_cmd+=(--auto-minor-version-upgrade)  || restore_cmd+=(--no-auto-minor-version-upgrade)
  [[ "${deletion_protection}" == "true" ]] && restore_cmd+=(--deletion-protection)        || restore_cmd+=(--no-deletion-protection)
  [[ -n "${iops}" ]]             && restore_cmd+=(--iops "${iops}")
  [[ -n "${db_name}" ]]          && restore_cmd+=(--db-name "${db_name}")
  [[ -n "${option_group_name}" ]] && restore_cmd+=(--option-group-name "${option_group_name}")
  [[ -n "${ca_cert}" ]]          && restore_cmd+=(--ca-certificate-identifier "${ca_cert}")
  [[ -n "${timezone}" ]]         && restore_cmd+=(--timezone "${timezone}")
  [[ "${storage_encrypted}" == "true" && -n "${kms_key}" ]] && restore_cmd+=(--kms-key-id "${kms_key}")

  _rds_info "Restoring instance from snapshot..."
  "${restore_cmd[@]}" > /dev/null

  _rds_info "Waiting for restored instance to become available (may take 10-20 min)..."
  aws rds wait db-instance-available \
    --region "${_RDS_REGION}" \
    --db-instance-identifier "${_RDS_INSTANCE_ID}"
  _rds_success "Restored instance is available."

  local restored_arn
  restored_arn=$(aws rds describe-db-instances \
    --region "${_RDS_REGION}" \
    --db-instance-identifier "${_RDS_INSTANCE_ID}" \
    --query 'DBInstances[0].DBInstanceArn' \
    --output text)

  if [[ "$(echo "${tags_json}" | jq 'length')" -gt 0 ]]; then
    _rds_info "Re-applying original tags..."
    aws rds add-tags-to-resource \
      --region "${_RDS_REGION}" \
      --resource-name "${restored_arn}" \
      --tags "$(echo "${tags_json}" | jq -c '.')" \
      --output text > /dev/null
    _rds_success "Tags restored."
  fi

  # Endpoint is unchanged — RDS derives it from the instance identifier,
  # so restoring with the same instance ID preserves the original hostname.
  _rds_success "Endpoint unchanged: $(echo "${_RDS_DB_JSON}" | jq -r '.Endpoint.Address')"
}

# ---------------------------------------------------------------------------
# Parse args, set private state vars, and run the migration
# ---------------------------------------------------------------------------
_rds_parse_args() {
  _RDS_INSTANCE_ID=""
  _RDS_REGION=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --instance-id) _RDS_INSTANCE_ID="$2"; shift 2 ;;
      --region)      _RDS_REGION="$2";      shift 2 ;;
      *)
        echo "Usage: rds_migrate --instance-id <id> --region <region>"
        return 1
        ;;
    esac
  done

  [[ -z "${_RDS_INSTANCE_ID}" ]] && { _rds_error "--instance-id is required"; return 1; }
  [[ -z "${_RDS_REGION}" ]]      && { _rds_error "--region is required";      return 1; }

  _RDS_SNAPSHOT_ID="pre-migration-${_RDS_INSTANCE_ID}-$(date +%Y%m%d%H%M%S)"
  _RDS_DB_JSON=""
}

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
rds_migrate() {
  command -v aws > /dev/null || _rds_die "aws CLI not found."
  command -v jq  > /dev/null || _rds_die "jq not found."

  _rds_parse_args "$@" || return 1

  _rds_info "=========================================="
  _rds_info " RDS Safe Migration"
  _rds_info " Instance : ${_RDS_INSTANCE_ID}"
  _rds_info " Region   : ${_RDS_REGION}"
  _rds_info "=========================================="

  _rds_fetch_instance_config
  _rds_create_snapshot

  local migration_exit_code
  set +e
  run_migration
  migration_exit_code=$?
  set -e

  if [[ ${migration_exit_code} -eq 0 ]]; then
    _rds_success "Migration succeeded. Snapshot ${_RDS_SNAPSHOT_ID} retained for safety."
    return 0
  else
    _rds_error "Migration failed (exit ${migration_exit_code})."
    _rds_rollback
    _rds_error "Rollback complete. DB restored to pre-migration state."
    return 1
  fi
}

# Run directly if executed as a script (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  rds_migrate "$@"
fi
```
