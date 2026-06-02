import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Rejection Cleanup CodeBuild project.
 *
 * This project is triggered by an EventBridge rule when the ManualApproval
 * action is rejected or times out. It reads the changeset-summary.json
 * artifact from the pipeline's artifact bucket and deletes all pending
 * change sets listed in the summary.
 *
 * Validates: Requirements 5.3, 5.4
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

echo "=== Rejection Cleanup: Deleting Pending Change Sets ==="

# The changeset summary is passed via the CHANGESET_SUMMARY environment variable
# or read from the artifact bucket
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

# Delete each change set
ERRORS=0
for i in $(seq 0 $((CHANGESET_COUNT - 1))); do
  STACK_NAME=$(jq -r ".changeSets[$i].stackName" "$SUMMARY_FILE")
  CHANGE_SET_NAME=$(jq -r ".changeSets[$i].changeSetName" "$SUMMARY_FILE")

  echo ""
  echo "Deleting change set '$CHANGE_SET_NAME' for stack '$STACK_NAME'..."

  if aws cloudformation delete-change-set \
    --stack-name "$STACK_NAME" \
    --change-set-name "$CHANGE_SET_NAME" 2>&1; then
    echo "  Successfully deleted change set."
  else
    echo "  WARNING: Failed to delete change set (may already be deleted or executed)."
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
echo "=== Cleanup Complete ==="
if [ "$ERRORS" -gt 0 ]; then
  echo "Note: $ERRORS change set(s) could not be deleted (may already be gone)."
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
