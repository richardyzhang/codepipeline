import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Rejection Cleanup CodeBuild project.
 *
 * This project is triggered by an EventBridge rule when the ManualApproval
 * action is rejected or times out. It reads the changeset-summary.json
 * artifact from the pipeline's artifact bucket and deletes all pending
 * change sets listed in the summary.
 *
 * Cross-account support:
 * - Reads targetAccountId from each changeset-summary.json entry
 * - Compares with pipelineAccountId (from summary or STS GetCallerIdentity fallback)
 * - If different: assumes githubExecutionRole in the target account via STS
 * - If same: uses default CodeBuild credentials
 * - Resets credentials after each entry
 * - On AssumeRole failure: logs error, skips that entry, continues
 *
 * Validates: Requirements 4.1, 4.2, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2
 */
export function generateRejectionCleanupBuildSpec(): codebuild.BuildSpec {
  return codebuild.BuildSpec.fromObject({
    version: '0.2',
    phases: {
      install: {
        'runtime-versions': {
          nodejs: '18',
        },
        commands: [
          'echo "Installing jq for JSON processing"',
          'apt-get update -qq && apt-get install -y -qq jq > /dev/null 2>&1 || true',
        ],
      },
      build: {
        commands: [
          // Write the cleanup script
          `cat << 'SCRIPT' > /tmp/cleanup-changesets.sh
#!/bin/bash
set -e

REGION="us-west-2"

echo "=== Rejection Cleanup: Deleting Pending Change Sets ==="

# The changeset summary is retrieved from the artifact bucket
ARTIFACT_BUCKET="$ARTIFACT_BUCKET_NAME"
ARTIFACT_KEY="$ARTIFACT_OBJECT_KEY"

if [ -z "$ARTIFACT_BUCKET" ] || [ -z "$ARTIFACT_KEY" ]; then
  echo "ERROR: ARTIFACT_BUCKET_NAME or ARTIFACT_OBJECT_KEY not set."
  echo "Attempting to find changeset-summary.json in the current directory..."
  if [ -f "changeset-summary.json" ]; then
    SUMMARY_FILE="changeset-summary.json"
  else
    echo "WARNING: No changeset-summary.json found. Nothing to clean up."
    exit 0
  fi
else
  echo "Downloading changeset summary from s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY"
  # Download and unzip the artifact
  aws s3 cp "s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" /tmp/artifact.zip 2>&1 || {
    echo "WARNING: Failed to download artifact. Change sets may need manual cleanup."
    exit 0
  }
  unzip -o /tmp/artifact.zip -d /tmp/artifact 2>&1 || {
    echo "WARNING: Failed to unzip artifact. Change sets may need manual cleanup."
    exit 0
  }
  SUMMARY_FILE=$(find /tmp/artifact -name "changeset-summary.json" | head -1)
  if [ -z "$SUMMARY_FILE" ]; then
    echo "WARNING: changeset-summary.json not found in artifact. Nothing to clean up."
    exit 0
  fi
fi

echo "Reading changeset summary from: $SUMMARY_FILE"
cat "$SUMMARY_FILE"

CHANGESET_COUNT=$(jq -r '.changeSets | length' "$SUMMARY_FILE")

if [ "$CHANGESET_COUNT" = "0" ]; then
  echo "No change sets to delete."
  exit 0
fi

echo ""
echo "Found $CHANGESET_COUNT change set(s) to delete."

# Get pipelineAccountId from the summary, fall back to STS GetCallerIdentity
PIPELINE_ACCOUNT_ID=$(jq -r '.pipelineAccountId // empty' "$SUMMARY_FILE")
if [ -z "$PIPELINE_ACCOUNT_ID" ]; then
  echo "pipelineAccountId not found in summary. Resolving via STS GetCallerIdentity..."
  PIPELINE_ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text --region "$REGION" 2>&1)
  if [ $? -ne 0 ] || [ -z "$PIPELINE_ACCOUNT_ID" ]; then
    echo "ERROR: Failed to resolve pipeline account ID. Cannot determine cross-account context."
    echo "Proceeding with cleanup using default credentials only."
    PIPELINE_ACCOUNT_ID=""
  fi
fi

echo "Pipeline account: $PIPELINE_ACCOUNT_ID"

# Function to reset credentials back to default (CodeBuild role)
reset_credentials() {
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  echo "  Credentials reset to default CodeBuild role."
}

# Function to assume cross-account role
# Returns 0 on success, 1 on failure
assume_role_if_needed() {
  local TARGET_ACCOUNT="$1"
  local PIPELINE_ACCOUNT="$2"

  if [ -n "$PIPELINE_ACCOUNT" ] && [ "$TARGET_ACCOUNT" != "$PIPELINE_ACCOUNT" ]; then
    local ROLE_ARN="arn:aws:iam::\${TARGET_ACCOUNT}:role/githubExecutionRole"
    echo "  Cross-account cleanup: assuming role $ROLE_ARN"

    local CREDS
    CREDS=$(aws sts assume-role \\
      --role-arn "$ROLE_ARN" \\
      --role-session-name "pipeline-rejection-cleanup" \\
      --duration-seconds 3600 \\
      --region "$REGION" \\
      --output json 2>&1)

    if [ $? -ne 0 ]; then
      echo "  ERROR: Failed to assume role $ROLE_ARN"
      echo "  STS Error: $CREDS"
      return 1
    fi

    export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')
    export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')
    export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')
    echo "  Successfully assumed role in account $TARGET_ACCOUNT"
  else
    echo "  Same-account cleanup: using default CodeBuild credentials."
  fi
  return 0
}

# Delete each change set
ERRORS=0
for i in $(seq 0 $((CHANGESET_COUNT - 1))); do
  STACK_NAME=$(jq -r ".changeSets[$i].stackName" "$SUMMARY_FILE")
  CHANGE_SET_NAME=$(jq -r ".changeSets[$i].changeSetName" "$SUMMARY_FILE")
  TARGET_ACCOUNT_ID=$(jq -r ".changeSets[$i].targetAccountId // empty" "$SUMMARY_FILE")

  echo ""
  echo "--- Deleting change set '$CHANGE_SET_NAME' for stack '$STACK_NAME' ---"
  echo "  Target account: \${TARGET_ACCOUNT_ID:-(same as pipeline)}"

  # Assume cross-account role if needed
  if [ -n "$TARGET_ACCOUNT_ID" ]; then
    if ! assume_role_if_needed "$TARGET_ACCOUNT_ID" "$PIPELINE_ACCOUNT_ID"; then
      echo "  SKIPPING cleanup of change set for stack $STACK_NAME due to AssumeRole failure."
      ERRORS=$((ERRORS + 1))
      reset_credentials
      continue
    fi
  fi

  # Delete the change set
  if aws cloudformation delete-change-set \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" \\
    --region "$REGION" 2>&1; then
    echo "  Successfully deleted change set."
  else
    echo "  WARNING: Failed to delete change set (may already be deleted or executed)."
    ERRORS=$((ERRORS + 1))
  fi

  # Reset credentials after each entry
  reset_credentials
done

echo ""
echo "=== Cleanup Complete ==="
if [ "$ERRORS" -gt 0 ]; then
  echo "Note: $ERRORS change set(s) could not be cleaned up (may already be gone or inaccessible)."
fi
exit 0
SCRIPT
chmod +x /tmp/cleanup-changesets.sh`,

          // Execute the cleanup script
          '/tmp/cleanup-changesets.sh',
        ],
      },
    },
  });
}
