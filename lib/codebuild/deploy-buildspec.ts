import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Deployment CodeBuild project.
 *
 * The buildspec:
 * 1. Reads changeset-summary.json from the ChangesetSummaryArtifact
 * 2. For each change set entry, determines if cross-account role assumption is needed
 * 3. If targetAccountId differs from pipelineAccountId: assumes githubExecutionRole via STS
 * 4. If targetAccountId equals pipelineAccountId: uses default CodeBuild credentials
 * 5. Executes each change set with --region us-west-2
 * 6. Waits for stack terminal state with 60-minute timeout
 * 7. Resets credentials after each stack (success or failure)
 * 8. On AssumeRole failure: records stack as failed in deployment report, continues to next
 * 9. On stack failure state (CREATE_FAILED, ROLLBACK_COMPLETE, UPDATE_ROLLBACK_COMPLETE): records as failed, continues
 * 10. Outputs deployment-report.json
 */
export function generateDeployBuildSpec(): codebuild.BuildSpec {
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
          `cat << 'SCRIPT' > /tmp/deploy-changesets.sh
#!/bin/bash
set -e

CHANGESET_SUMMARY_PATH="$CODEBUILD_SRC_DIR_ChangesetSummaryArtifact/changeset-summary.json"
REGION="us-west-2"

echo "=== Deployment Stage ==="
echo "Changeset summary: $CHANGESET_SUMMARY_PATH"
echo "Region: $REGION"

# Read the changeset summary
if [ ! -f "$CHANGESET_SUMMARY_PATH" ]; then
  echo "ERROR: changeset-summary.json not found at $CHANGESET_SUMMARY_PATH"
  exit 1
fi

PIPELINE_ACCOUNT_ID=$(jq -r '.pipelineAccountId' "$CHANGESET_SUMMARY_PATH")
CHANGESET_COUNT=$(jq -r '.changeSets | length' "$CHANGESET_SUMMARY_PATH")

echo "Pipeline account: $PIPELINE_ACCOUNT_ID"
echo "Found $CHANGESET_COUNT change set(s) to execute."

# Handle empty changeset summary
if [ "$CHANGESET_COUNT" = "0" ]; then
  echo "No change sets to execute. Skipping deployment."
  jq -n --arg eid "\${CODEBUILD_BUILD_ID:-unknown}" \\
    '{executionId: $eid, deployedStacks: [], failedStacks: []}' > deployment-report.json
  cat deployment-report.json
  exit 0
fi

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

  if [ "$TARGET_ACCOUNT" != "$PIPELINE_ACCOUNT" ]; then
    local ROLE_ARN="arn:aws:iam::\${TARGET_ACCOUNT}:role/githubExecutionRole"
    echo "  Cross-account deployment: assuming role $ROLE_ARN"

    local CREDS
    CREDS=$(aws sts assume-role \\
      --role-arn "$ROLE_ARN" \\
      --role-session-name "pipeline-deploy" \\
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
    echo "  Same-account deployment: using default CodeBuild credentials."
  fi
  return 0
}

# Initialize result arrays
jq -n '{deployedStacks: [], failedStacks: []}' > /tmp/deploy-results.json

for i in $(seq 0 $(($CHANGESET_COUNT - 1))); do
  STACK_NAME=$(jq -r ".changeSets[$i].stackName" "$CHANGESET_SUMMARY_PATH")
  CHANGE_SET_NAME=$(jq -r ".changeSets[$i].changeSetName" "$CHANGESET_SUMMARY_PATH")
  TARGET_ACCOUNT_ID=$(jq -r ".changeSets[$i].targetAccountId" "$CHANGESET_SUMMARY_PATH")

  echo ""
  echo "--- Executing change set '$CHANGE_SET_NAME' for stack '$STACK_NAME' ---"
  echo "  Target account: $TARGET_ACCOUNT_ID"

  # Assume cross-account role if needed
  if ! assume_role_if_needed "$TARGET_ACCOUNT_ID" "$PIPELINE_ACCOUNT_ID"; then
    echo "  SKIPPING stack $STACK_NAME due to AssumeRole failure."
    ENTRY=$(jq -n \\
      --arg sn "$STACK_NAME" \\
      --arg aid "$TARGET_ACCOUNT_ID" \\
      '{stackName: $sn, targetAccountId: $aid, status: "FAILED", error: "AssumeRole failed"}')
    jq --argjson entry "$ENTRY" '.failedStacks += [$entry]' /tmp/deploy-results.json > /tmp/deploy-results-tmp.json
    mv /tmp/deploy-results-tmp.json /tmp/deploy-results.json
    reset_credentials
    continue
  fi

  # Execute the change set
  if ! aws cloudformation execute-change-set \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" \\
    --region "$REGION" 2>&1; then
    echo "  ERROR: Failed to execute change set for stack $STACK_NAME"
    ENTRY=$(jq -n \\
      --arg sn "$STACK_NAME" \\
      --arg aid "$TARGET_ACCOUNT_ID" \\
      '{stackName: $sn, targetAccountId: $aid, status: "FAILED", error: "Failed to execute change set"}')
    jq --argjson entry "$ENTRY" '.failedStacks += [$entry]' /tmp/deploy-results.json > /tmp/deploy-results-tmp.json
    mv /tmp/deploy-results-tmp.json /tmp/deploy-results.json
    reset_credentials
    continue
  fi

  # Wait for stack to reach terminal state (60-minute timeout via --cli-read-timeout)
  echo "  Waiting for stack $STACK_NAME to complete (60-minute timeout)..."

  DEPLOY_SUCCESS=false

  # Try waiting for stack-update-complete first
  if aws cloudformation wait stack-update-complete \\
    --stack-name "$STACK_NAME" \\
    --region "$REGION" 2>/dev/null; then
    echo "  SUCCESS: Stack $STACK_NAME updated successfully."
    DEPLOY_SUCCESS=true
  else
    # If update wait fails, try create-complete (new stack)
    if aws cloudformation wait stack-create-complete \\
      --stack-name "$STACK_NAME" \\
      --region "$REGION" 2>/dev/null; then
      echo "  SUCCESS: Stack $STACK_NAME created successfully."
      DEPLOY_SUCCESS=true
    fi
  fi

  if [ "$DEPLOY_SUCCESS" = "true" ]; then
    ENTRY=$(jq -n \\
      --arg sn "$STACK_NAME" \\
      --arg aid "$TARGET_ACCOUNT_ID" \\
      '{stackName: $sn, targetAccountId: $aid, status: "SUCCESS"}')
    jq --argjson entry "$ENTRY" '.deployedStacks += [$entry]' /tmp/deploy-results.json > /tmp/deploy-results-tmp.json
    mv /tmp/deploy-results-tmp.json /tmp/deploy-results.json
  else
    # Check for failure terminal states
    STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \\
      --region "$REGION" \\
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "UNKNOWN")
    STACK_REASON=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \\
      --region "$REGION" \\
      --query 'Stacks[0].StackStatusReason' --output text 2>/dev/null || echo "Unknown reason")

    echo "  ERROR: Stack $STACK_NAME failed (Status: $STACK_STATUS, Reason: $STACK_REASON)"

    ENTRY=$(jq -n \\
      --arg sn "$STACK_NAME" \\
      --arg aid "$TARGET_ACCOUNT_ID" \\
      --arg status "$STACK_STATUS" \\
      --arg err "$STACK_REASON" \\
      '{stackName: $sn, targetAccountId: $aid, status: "FAILED", stackStatus: $status, error: $err}')
    jq --argjson entry "$ENTRY" '.failedStacks += [$entry]' /tmp/deploy-results.json > /tmp/deploy-results-tmp.json
    mv /tmp/deploy-results-tmp.json /tmp/deploy-results.json
  fi

  # Reset credentials after each stack (success or failure)
  reset_credentials
done

echo ""
echo "=== Deployment Complete ==="

# Build the final deployment report
DEPLOYED=$(jq '.deployedStacks' /tmp/deploy-results.json)
FAILED_STACKS=$(jq '.failedStacks' /tmp/deploy-results.json)

jq -n --arg eid "\${CODEBUILD_BUILD_ID:-unknown}" \\
  --argjson deployed "$DEPLOYED" \\
  --argjson failed "$FAILED_STACKS" \\
  '{executionId: $eid, deployedStacks: $deployed, failedStacks: $failed}' > deployment-report.json

echo "Deployment report:"
cat deployment-report.json

# Exit with failure if any stacks failed
FAILED_COUNT=$(echo "$FAILED_STACKS" | jq 'length')
if [ "$FAILED_COUNT" -gt 0 ]; then
  echo ""
  echo "ERROR: $FAILED_COUNT stack deployment(s) failed."
  exit 1
fi
SCRIPT
chmod +x /tmp/deploy-changesets.sh`,

          '/tmp/deploy-changesets.sh',
        ],
      },
    },
    artifacts: {
      'base-directory': '.',
      files: ['deployment-report.json'],
    },
  });
}
