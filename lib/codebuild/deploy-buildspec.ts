import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Deployment CodeBuild project.
 *
 * The buildspec:
 * 1. Reads changeset-summary.json from the changeset summary artifact
 * 2. Executes each change set sequentially (no dependency ordering needed)
 * 3. Waits for each stack to reach UPDATE_COMPLETE or CREATE_COMPLETE
 * 4. Produces a deployment report
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

CHANGESET_SUMMARY_PATH="$1"

echo "=== Deployment Stage ==="
echo "Changeset summary: $CHANGESET_SUMMARY_PATH"

# Read the changeset summary
if [ ! -f "$CHANGESET_SUMMARY_PATH" ]; then
  echo "ERROR: changeset-summary.json not found at $CHANGESET_SUMMARY_PATH"
  exit 1
fi

CHANGESET_COUNT=$(jq -r '.changeSets | length' "$CHANGESET_SUMMARY_PATH")

# Handle empty changeset summary
if [ "$CHANGESET_COUNT" = "0" ]; then
  echo "No change sets to execute. Skipping deployment."
  jq -n --arg eid "\${CODEBUILD_BUILD_ID:-unknown}" \\
    '{executionId: $eid, deployedStacks: [], skippedStacks: []}' > deployment-report.json
  cat deployment-report.json
  exit 0
fi

echo "Found $CHANGESET_COUNT change set(s) to execute."

# Track results
> /tmp/success-stacks.txt
> /tmp/failed-stacks.txt

# Execute each change set
for i in $(seq 0 $((CHANGESET_COUNT - 1))); do
  STACK_NAME=$(jq -r ".changeSets[$i].stackName" "$CHANGESET_SUMMARY_PATH")
  CHANGE_SET_NAME=$(jq -r ".changeSets[$i].changeSetName" "$CHANGESET_SUMMARY_PATH")

  echo ""
  echo "--- Executing change set '$CHANGE_SET_NAME' for stack '$STACK_NAME' ---"

  # Execute the change set
  if ! aws cloudformation execute-change-set \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" 2>&1; then
    echo "ERROR: Failed to execute change set for stack $STACK_NAME"
    echo "$STACK_NAME|Failed to execute change set" >> /tmp/failed-stacks.txt
    continue
  fi

  # Wait for stack to complete
  echo "  Waiting for stack $STACK_NAME to complete..."
  if aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" 2>&1; then
    echo "  SUCCESS: Stack $STACK_NAME deployed successfully."
    echo "$STACK_NAME" >> /tmp/success-stacks.txt
  elif aws cloudformation wait stack-create-complete --stack-name "$STACK_NAME" 2>&1; then
    echo "  SUCCESS: Stack $STACK_NAME created successfully."
    echo "$STACK_NAME" >> /tmp/success-stacks.txt
  else
    STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \\
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "UNKNOWN")
    STACK_REASON=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \\
      --query 'Stacks[0].StackStatusReason' --output text 2>/dev/null || echo "Unknown reason")
    echo "  ERROR: Stack $STACK_NAME failed (Status: $STACK_STATUS, Reason: $STACK_REASON)"
    echo "$STACK_NAME|$STACK_REASON" >> /tmp/failed-stacks.txt
  fi
done

echo ""
echo "=== Deployment Complete ==="

# Build the deployment report
DEPLOYED_STACKS="[]"
if [ -s /tmp/success-stacks.txt ]; then
  DEPLOYED_STACKS=$(cat /tmp/success-stacks.txt | jq -R '{stackName: ., status: "SUCCESS"}' | jq -s '.')
fi

FAILED_RESULTS="[]"
if [ -s /tmp/failed-stacks.txt ]; then
  FAILED_RESULTS=$(cat /tmp/failed-stacks.txt | while IFS='|' read -r name error; do
    jq -n --arg sn "$name" --arg err "\${error:-Deployment failed}" \\
      '{stackName: $sn, status: "FAILED", error: $err}'
  done | jq -s '.')
fi

ALL_RESULTS=$(echo "[$DEPLOYED_STACKS, $FAILED_RESULTS]" | jq 'add | map(select(. != null))')

jq -n --arg eid "\${CODEBUILD_BUILD_ID:-unknown}" \\
  --argjson deployed "$ALL_RESULTS" \\
  '{executionId: $eid, deployedStacks: $deployed, skippedStacks: []}' > deployment-report.json

echo "Deployment report:"
cat deployment-report.json

# Exit with failure if any stacks failed
if [ -s /tmp/failed-stacks.txt ]; then
  echo ""
  echo "ERROR: One or more stack deployments failed."
  exit 1
fi
SCRIPT
chmod +x /tmp/deploy-changesets.sh`,

          '/tmp/deploy-changesets.sh "$CODEBUILD_SRC_DIR_ChangesetSummaryArtifact/changeset-summary.json"',
        ],
      },
    },
    artifacts: {
      'base-directory': '.',
      files: ['deployment-report.json'],
    },
  });
}
