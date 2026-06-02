import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Changeset Creation CodeBuild project.
 *
 * The buildspec:
 * 1. Reads change-manifest.json from the change detection artifact
 * 2. For each template path, derives the stack name from the filename (without extension)
 * 3. Creates a CloudFormation change set via AWS CLI (no parameters, no tags)
 * 4. Waits for each change set to reach CREATE_COMPLETE status
 * 5. Writes changeset-summary.json as an output artifact
 *
 * Stack name derivation: "templates/vpc.yaml" → "vpc"
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

CHANGE_MANIFEST_PATH="$1"
SOURCE_DIR="$2"
COMMIT_SHA="$3"

echo "=== Changeset Creation Stage ==="
echo "Change manifest: $CHANGE_MANIFEST_PATH"
echo "Source dir: $SOURCE_DIR"
echo "Commit SHA: $COMMIT_SHA"

# Read the change manifest
if [ ! -f "$CHANGE_MANIFEST_PATH" ]; then
  echo "ERROR: change-manifest.json not found at $CHANGE_MANIFEST_PATH"
  exit 1
fi

CHANGED_TEMPLATES=$(jq -r '.changedTemplates[]' "$CHANGE_MANIFEST_PATH" 2>/dev/null || echo "")
CHANGED_COUNT=$(jq -r '.changedTemplates | length' "$CHANGE_MANIFEST_PATH")

# Handle empty manifest
if [ "$CHANGED_COUNT" = "0" ]; then
  echo "No templates changed. Skipping changeset creation."
  echo '{"changeSets": []}' | jq . > changeset-summary.json
  cat changeset-summary.json
  exit 0
fi

echo "Found $CHANGED_COUNT changed template(s)."

# Generate a unique change set name suffix
CS_SUFFIX=$(echo "$COMMIT_SHA" | cut -c 1-8)
CS_PREFIX="pipeline-cs"

# Initialize changeset summary
echo '{"changeSets": []}' > changeset-summary.json

FAILED=0
for TEMPLATE in $CHANGED_TEMPLATES; do
  # Derive stack name from filename without extension
  STACK_NAME=$(basename "$TEMPLATE" | sed 's/\\.[^.]*$//')

  CHANGE_SET_NAME="\${CS_PREFIX}-\${CS_SUFFIX}-$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"

  echo ""
  echo "--- Creating change set for stack: $STACK_NAME ---"
  echo "  Template: $TEMPLATE"
  echo "  Change set name: $CHANGE_SET_NAME"

  # Check if template file exists in source
  if [ ! -f "$SOURCE_DIR/$TEMPLATE" ]; then
    echo "ERROR: Template file not found: $SOURCE_DIR/$TEMPLATE"
    FAILED=1
    continue
  fi

  # Check if stack exists (to determine CREATE or UPDATE)
  STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" 2>/dev/null && echo "yes" || echo "no")
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
    --template-body "file://$SOURCE_DIR/$TEMPLATE" \\
    --change-set-type "$CS_TYPE" \\
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND 2>&1; then
    echo "ERROR: Failed to create change set for stack $STACK_NAME"
    FAILED=1
    continue
  fi

  # Wait for the change set to complete
  echo "  Waiting for change set to be created..."
  if ! aws cloudformation wait change-set-create-complete \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" 2>&1; then

    CS_REASON=$(aws cloudformation describe-change-set \\
      --stack-name "$STACK_NAME" \\
      --change-set-name "$CHANGE_SET_NAME" \\
      --query 'StatusReason' --output text 2>/dev/null || echo "Unknown reason")

    if echo "$CS_REASON" | grep -qi "didn.t contain changes\\|No updates are to be performed\\|no changes"; then
      echo "  No changes detected for stack $STACK_NAME. Skipping."
      aws cloudformation delete-change-set \\
        --stack-name "$STACK_NAME" \\
        --change-set-name "$CHANGE_SET_NAME" 2>/dev/null || true
      continue
    else
      echo "ERROR: Change set creation failed for stack $STACK_NAME (Reason: $CS_REASON)"
      FAILED=1
      continue
    fi
  fi

  # Describe the change set to get changes
  CHANGES=$(aws cloudformation describe-change-set \\
    --stack-name "$STACK_NAME" \\
    --change-set-name "$CHANGE_SET_NAME" \\
    --query 'Changes[].ResourceChange.{action:Action,resourceType:ResourceType,logicalId:LogicalResourceId}' \\
    --output json 2>/dev/null || echo "[]")

  echo "  Change set created successfully with $(echo "$CHANGES" | jq 'length') change(s)."

  # Append to changeset summary
  ENTRY=$(jq -n \\
    --arg sn "$STACK_NAME" \\
    --arg csn "$CHANGE_SET_NAME" \\
    --argjson changes "$CHANGES" \\
    '{stackName: $sn, changeSetName: $csn, changes: $changes}')

  jq --argjson entry "$ENTRY" '.changeSets += [$entry]' changeset-summary.json > changeset-summary-tmp.json
  mv changeset-summary-tmp.json changeset-summary.json
done

echo ""
echo "=== Changeset Creation Complete ==="
echo "Changeset summary:"
cat changeset-summary.json

if [ "$FAILED" -ne 0 ]; then
  echo "ERROR: One or more change set creations failed."
  exit 1
fi
SCRIPT
chmod +x /tmp/create-changesets.sh`,

          '/tmp/create-changesets.sh "$CODEBUILD_SRC_DIR_ChangeManifestArtifact/change-manifest.json" "$CODEBUILD_SRC_DIR" "$CODEBUILD_RESOLVED_SOURCE_VERSION"',
        ],
      },
    },
    artifacts: {
      'base-directory': '.',
      files: ['changeset-summary.json'],
    },
  });
}
