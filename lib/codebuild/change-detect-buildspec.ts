import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Change Detection CodeBuild project.
 *
 * The buildspec reads a comma-separated list of template paths from the
 * CHANGED_FILES environment variable (passed as a pipeline parameter),
 * filters to JSON-only files, resolves target accounts from SSM Parameter
 * Store based on folder name, and writes an enriched change-manifest.json.
 *
 * Stack names are derived from folder + filename: "dev/ec2.json" → "dev-ec2"
 *
 * Exit non-zero if:
 * - All files are non-JSON (no templates to process)
 * - SSM parameter is missing or invalid for a folder
 * - STS GetCallerIdentity fails
 */
export function generateChangeDetectBuildSpec(): codebuild.BuildSpec {
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
          `cat << 'SCRIPT' > /tmp/detect-changes.sh
#!/bin/bash
set -e

REGION="us-west-2"
CHANGED_FILES_INPUT="$1"

# CHANGED_FILES must be provided
if [ -z "$CHANGED_FILES_INPUT" ] || [ "$CHANGED_FILES_INPUT" = "ALL" ]; then
  echo "ERROR: CHANGED_FILES must be a comma-separated list of template paths (e.g., dev/ec2.json,prod/ec2.json)"
  exit 1
fi

echo "Processing changed files: $CHANGED_FILES_INPUT"

# Get pipeline account ID via STS GetCallerIdentity
echo "Resolving pipeline account ID..."
PIPELINE_ACCOUNT_ID=$(aws sts get-caller-identity --region "$REGION" --query 'Account' --output text 2>&1)
if [ $? -ne 0 ] || [ -z "$PIPELINE_ACCOUNT_ID" ]; then
  echo "ERROR: Failed to resolve pipeline account ID via STS GetCallerIdentity"
  echo "$PIPELINE_ACCOUNT_ID"
  exit 1
fi
echo "Pipeline account ID: $PIPELINE_ACCOUNT_ID"

# Split comma-separated files and filter
IFS=',' read -ra FILE_ARRAY <<< "$CHANGED_FILES_INPUT"

CHANGED_TEMPLATES="[]"
SKIPPED_FILES="[]"

for FILE_PATH in "\${FILE_ARRAY[@]}"; do
  # Trim whitespace
  FILE_PATH=$(echo "$FILE_PATH" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  # Skip empty entries
  if [ -z "$FILE_PATH" ]; then
    continue
  fi

  # Check if file ends with .json (case-insensitive)
  LOWER_PATH=$(echo "$FILE_PATH" | tr '[:upper:]' '[:lower:]')
  if [[ "$LOWER_PATH" != *.json ]]; then
    echo "Skipping non-JSON file: $FILE_PATH"
    SKIPPED_FILES=$(echo "$SKIPPED_FILES" | jq --arg f "$FILE_PATH" '. + [$f]')
    continue
  fi

  # Validate template has at least one / (must reside in a folder)
  if [[ "$FILE_PATH" != */* ]]; then
    echo "ERROR: Template '$FILE_PATH' does not reside in a folder. Templates must be in a folder (e.g., dev/ec2.json)"
    exit 1
  fi

  # Extract folder (first path segment)
  FOLDER=$(echo "$FILE_PATH" | cut -d'/' -f1)

  # Derive stack name: {folder}-{filename_without_extension}
  FILENAME=$(basename "$FILE_PATH")
  NAME_NO_EXT="\${FILENAME%.*}"
  RAW_STACK_NAME="\${FOLDER}-\${NAME_NO_EXT}"

  # Sanitize for CloudFormation naming rules: [a-zA-Z][-a-zA-Z0-9]*
  STACK_NAME=$(echo "$RAW_STACK_NAME" | sed 's/[^a-zA-Z0-9-]/-/g')
  # Prepend cfn- if first character is not a letter
  if [[ ! "$STACK_NAME" =~ ^[a-zA-Z] ]]; then
    STACK_NAME="cfn-$STACK_NAME"
  fi
  # Truncate to 128 characters
  STACK_NAME="\${STACK_NAME:0:128}"

  echo "Template: $FILE_PATH -> folder=$FOLDER, stackName=$STACK_NAME"

  # Look up target account ID from SSM Parameter Store
  SSM_PARAM_PATH="/cfn-deploy/accounts/$FOLDER"
  echo "Looking up SSM parameter: $SSM_PARAM_PATH"
  TARGET_ACCOUNT_ID=$(aws ssm get-parameter --name "$SSM_PARAM_PATH" --region "$REGION" --query 'Parameter.Value' --output text 2>&1)
  if [ $? -ne 0 ] || [ -z "$TARGET_ACCOUNT_ID" ] || [ "$TARGET_ACCOUNT_ID" = "None" ]; then
    echo "ERROR: SSM parameter '$SSM_PARAM_PATH' not found or empty. Cannot resolve target account for folder '$FOLDER'."
    echo "$TARGET_ACCOUNT_ID"
    exit 1
  fi

  # Validate account ID is a 12-digit numeric string
  if ! echo "$TARGET_ACCOUNT_ID" | grep -qE '^[0-9]{12}$'; then
    echo "ERROR: SSM parameter '$SSM_PARAM_PATH' contains invalid account ID '$TARGET_ACCOUNT_ID'. Expected a 12-digit numeric string."
    exit 1
  fi

  echo "Resolved target account for folder '$FOLDER': $TARGET_ACCOUNT_ID"

  # Add entry to changedTemplates array
  CHANGED_TEMPLATES=$(echo "$CHANGED_TEMPLATES" | jq \\
    --arg tp "$FILE_PATH" \\
    --arg sn "$STACK_NAME" \\
    --arg fl "$FOLDER" \\
    --arg ta "$TARGET_ACCOUNT_ID" \\
    '. + [{"templatePath": $tp, "stackName": $sn, "folder": $fl, "targetAccountId": $ta}]')
done

# Check if we have any templates to process
TEMPLATE_COUNT=$(echo "$CHANGED_TEMPLATES" | jq 'length')
if [ "$TEMPLATE_COUNT" -eq 0 ]; then
  echo "ERROR: No JSON templates found in changed files. All files were skipped."
  # Still output the manifest for debugging
  jq -n \\
    --argjson templates "$CHANGED_TEMPLATES" \\
    --arg pipelineAccount "$PIPELINE_ACCOUNT_ID" \\
    --argjson skipped "$SKIPPED_FILES" \\
    '{changedTemplates: $templates, pipelineAccountId: $pipelineAccount, skippedFiles: $skipped}' > change-manifest.json
  cat change-manifest.json
  exit 1
fi

# Build the enriched change manifest
jq -n \\
  --argjson templates "$CHANGED_TEMPLATES" \\
  --arg pipelineAccount "$PIPELINE_ACCOUNT_ID" \\
  --argjson skipped "$SKIPPED_FILES" \\
  '{changedTemplates: $templates, pipelineAccountId: $pipelineAccount, skippedFiles: $skipped}' > change-manifest.json

echo ""
echo "=== Change Manifest ==="
cat change-manifest.json
echo ""
echo "Processed $TEMPLATE_COUNT template(s), skipped $(echo "$SKIPPED_FILES" | jq 'length') file(s)"
SCRIPT
chmod +x /tmp/detect-changes.sh`,

          '/tmp/detect-changes.sh "$CHANGED_FILES"',
        ],
      },
    },
    artifacts: {
      'base-directory': '.',
      files: ['change-manifest.json'],
    },
  });
}
