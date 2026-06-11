import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Changeset Creation CodeBuild project.
 *
 * The buildspec:
 * 1. Reads enriched change-manifest.json from the ChangeManifestArtifact
 * 2. For each entry in changedTemplates, determines if cross-account role assumption is needed
 * 3. If targetAccountId differs from pipelineAccountId: assumes githubExecutionRole via STS
 * 4. If targetAccountId equals pipelineAccountId: uses default CodeBuild credentials
 * 5. Creates a CloudFormation change set in the target account with --region us-west-2
 * 6. Resets credentials after each stack operation (success or failure)
 * 7. On AssumeRole failure: skips that stack, records failure, continues with remaining entries
 * 8. Outputs changeset-summary.json with targetAccountId per entry and pipelineAccountId at top level
 */
export function generateChangesetCreateBuildSpec(): codebuild.BuildSpec {
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
          `cat << 'SCRIPT' > /tmp/create-changesets.sh
#!/bin/bash
set -e

CHANGE_MANIFEST_PATH="$CODEBUILD_SRC_DIR_ChangeManifestArtifact/change-manifest.json"
SOURCE_DIR="$CODEBUILD_SRC_DIR"
COMMIT_SHA="$CODEBUILD_RESOLVED_SOURCE_VERSION"
REGION="us-west-2"

echo "=== Changeset Creation Stage ==="
echo "Change manifest: $CHANGE_MANIFEST_PATH"
echo "Source dir: $SOURCE_DIR"
echo "Commit SHA: $COMMIT_SHA"
echo "Region: $REGION"

# Read the change manifest
if [ ! -f "$CHANGE_MANIFEST_PATH" ]; then
  echo "ERROR: change-manifest.json not found at $CHANGE_MANIFEST_PATH"
  exit 1
fi

PIPELINE_ACCOUNT_ID=$(jq -r '.pipelineAccountId' "$CHANGE_MANIFEST_PATH")
CHANGED_COUNT=$(jq -r '.changedTemplates | length' "$CHANGE_MANIFEST_PATH")

echo "Pipeline account: $PIPELINE_ACCOUNT_ID"
echo "Found $CHANGED_COUNT changed template(s)."

# Handle empty manifest
if [ "$CHANGED_COUNT" = "0" ]; then
  echo "No templates changed. Skipping changeset creation."
  echo "{\\\"changeSets\\\": [], \\\"pipelineAccountId\\\": \\\"$PIPELINE_ACCOUNT_ID\\\"}" | jq . > changeset-summary.json
  cat changeset-summary.json
  exit 0
fi

# Generate a unique change set name suffix
CS_SUFFIX=$(echo "$COMMIT_SHA" | cut -c 1-8)
CS_PREFIX="pipeline-cs"

# Initialize changeset summary with pipelineAccountId
jq -n --arg pid "$PIPELINE_ACCOUNT_ID" '{changeSets: [], pipelineAccountId: $pid}' > changeset-summary.json

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
      --role-session-name "pipeline-changeset-create" \\
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

FAILED=0
for i in $(seq 0 $(($CHANGED_COUNT - 1))); do
  TEMPLATE_PATH=$(jq -r ".changedTemplates[$i].templatePath" "$CHANGE_MANIFEST_PATH")
  STACK_NAME=$(jq -r ".changedTemplates[$i].stackName" "$CHANGE_MANIFEST_PATH")
  TARGET_ACCOUNT_ID=$(jq -r ".changedTemplates[$i].targetAccountId" "$CHANGE_MANIFEST_PATH")

  CHANGE_SET_NAME="\${CS_PREFIX}-\${CS_SUFFIX}-$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"

  echo ""
  echo "--- Creating change set for stack: $STACK_NAME ---"
  echo "  Template: $TEMPLATE_PATH"
  echo "  Target account: $TARGET_ACCOUNT_ID"
  echo "  Change set name: $CHANGE_SET_NAME"

  # Check if template file exists in source
  if [ ! -f "$SOURCE_DIR/$TEMPLATE_PATH" ]; then
    echo "ERROR: Template file not found: $SOURCE_DIR/$TEMPLATE_PATH"
    FAILED=1
    reset_credentials
    continue
  fi

  # Assume cross-account role if needed
  if ! assume_role_if_needed "$TARGET_ACCOUNT_ID" "$PIPELINE_ACCOUNT_ID"; then
    echo "  SKIPPING stack $STACK_NAME due to AssumeRole failure."
    ENTRY=$(jq -n \\
      --arg sn "$STACK_NAME" \\
      --arg csn "$CHANGE_SET_NAME" \\
      --arg aid "$TARGET_ACCOUNT_ID" \\
      '{stackName: $sn, changeSetName: $csn, targetAccountId: $aid, changes: [], error: "AssumeRole failed"}')
    jq --argjson entry "$ENTRY" '.changeSets += [$entry]' changeset-summary.json > changeset-summary-tmp.json
    mv changeset-summary-tmp.json changeset-summary.json
    FAILED=1
    reset_credentials
    continue
  fi

  # Check if stack exists (to determine CREATE vs UPDATE)
  STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null && echo "yes" || echo "no")
  if [ "$STACK_EXISTS" = "yes" ]; then
    CS_TYPE="UPDATE"
  else
    CS_TYPE="CREATE"
  fi

  echo "  Change set type: $CS_TYPE"

  # Create the change set (no parameters, no tags)
  if ! aws cloudformation create-change-set \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" \\
    --template-body "file://$SOURCE_DIR/$TEMPLATE_PATH" \\
    --change-set-type "$CS_TYPE" \\
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \\
    --region "$REGION" 2>&1; then
    echo "ERROR: Failed to create change set for stack $STACK_NAME"
    FAILED=1
    reset_credentials
    continue
  fi

  # Wait for the change set to complete
  echo "  Waiting for change set to be created..."
  if ! aws cloudformation wait change-set-create-complete \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" \\
    --region "$REGION" 2>&1; then

    CS_REASON=$(aws cloudformation describe-change-set \\
      --stack-name "$STACK_NAME" \\
      --change-set-name "$CHANGE_SET_NAME" \\
      --region "$REGION" \\
      --query 'StatusReason' --output text 2>/dev/null || echo "Unknown reason")

    if echo "$CS_REASON" | grep -qi "didn.t contain changes\\|No updates are to be performed\\|no changes"; then
      echo "  No changes detected for stack $STACK_NAME. Skipping."
      aws cloudformation delete-change-set \\
        --stack-name "$STACK_NAME" \\
        --change-set-name "$CHANGE_SET_NAME" \\
        --region "$REGION" 2>/dev/null || true
      reset_credentials
      continue
    else
      echo "ERROR: Change set creation failed for stack $STACK_NAME (Reason: $CS_REASON)"
      FAILED=1
      reset_credentials
      continue
    fi
  fi

  # Describe the change set to get changes
  CHANGES=$(aws cloudformation describe-change-set \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" \\
    --region "$REGION" \\
    --query 'Changes[].ResourceChange.{action:Action,resourceType:ResourceType,logicalId:LogicalResourceId}' \\
    --output json 2>/dev/null || echo "[]")

  echo "  Change set created successfully with $(echo "$CHANGES" | jq 'length') change(s)."

  # Append to changeset summary with targetAccountId
  ENTRY=$(jq -n \\
    --arg sn "$STACK_NAME" \\
    --arg csn "$CHANGE_SET_NAME" \\
    --arg aid "$TARGET_ACCOUNT_ID" \\
    --argjson changes "$CHANGES" \\
    '{stackName: $sn, changeSetName: $csn, targetAccountId: $aid, changes: $changes}')

  jq --argjson entry "$ENTRY" '.changeSets += [$entry]' changeset-summary.json > changeset-summary-tmp.json
  mv changeset-summary-tmp.json changeset-summary.json

  # Reset credentials after each stack operation
  reset_credentials
done

echo ""
echo "=== Changeset Creation Complete ==="
echo "Changeset summary:"
cat changeset-summary.json

# Export human-readable info for the Manual Approval popup
# (actual export happens outside the script in the CodeBuild command)
echo "Changeset info will be exported by CodeBuild after script completes."

if [ "$FAILED" -ne 0 ]; then
  echo "ERROR: One or more change set creations failed."
  exit 1
fi
SCRIPT
chmod +x /tmp/create-changesets.sh`,

          '/tmp/create-changesets.sh',
          // Set CHANGESET_INFO after the script runs so CodeBuild can export it
          'export CHANGESET_INFO=$(jq -r \'.changeSets[] | "Account: \\(.targetAccountId) | Stack: \\(.stackName) | ChangeSet: \\(.changeSetName)"\' changeset-summary.json | tr \'\\n\' \'; \' | sed \'s/; $//\')',
          'if [ -z "$CHANGESET_INFO" ]; then export CHANGESET_INFO="No change sets created."; fi',
          'echo "CHANGESET_INFO=$CHANGESET_INFO"',
        ],
      },
    },
    env: {
      'exported-variables': ['CHANGESET_INFO'],
    },
    artifacts: {
      'base-directory': '.',
      files: ['changeset-summary.json'],
    },
  });
}
