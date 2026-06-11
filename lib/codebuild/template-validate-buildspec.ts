import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Template Validation CodeBuild project.
 *
 * The buildspec:
 * 1. Reads change-manifest.json from the ChangeManifestArtifact
 * 2. Reads stack-mapping.json from the source artifact at the provided path
 * 3. If changedTemplates is empty and allChanged is false: produces empty report with status 'skipped', exits 0
 * 4. If allChanged is true: enumerates all template paths from stack-mapping.json
 * 5. For each template:
 *    - Checks file existence in $CODEBUILD_SRC_DIR
 *    - Parses as JSON (reports syntax errors using jq)
 *    - Validates structure: checks for "Resources" key, checks all top-level keys are valid CFN keys
 *    - For templates passing static checks: calls aws cloudformation validate-template
 *    - Retries transient API errors (Throttling, RequestTimeout) up to 3 times with exponential backoff
 * 6. Aggregates results into validation-report.json
 * 7. Exits non-zero if any template failed
 *
 * @param stackMappingPath - Path to stack-mapping.json relative to the source artifact root
 */
export function generateTemplateValidateBuildSpec(stackMappingPath: string): codebuild.BuildSpec {
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
          `cat << 'SCRIPT' > /tmp/validate-templates.sh
#!/bin/bash
set -e

CHANGE_MANIFEST_PATH="$CODEBUILD_SRC_DIR_ChangeManifestArtifact/change-manifest.json"
STACK_MAPPING_PATH="$CODEBUILD_SRC_DIR/${stackMappingPath}"
SOURCE_DIR="$CODEBUILD_SRC_DIR"

# Valid CloudFormation top-level keys
VALID_CFN_KEYS="AWSTemplateFormatVersion Description Metadata Parameters Rules Mappings Conditions Transform Resources Outputs"

echo "=== Template Validation Stage ==="
echo "Change manifest: $CHANGE_MANIFEST_PATH"
echo "Stack mapping: $STACK_MAPPING_PATH"
echo "Source dir: $SOURCE_DIR"

# Read the change manifest
if [ ! -f "$CHANGE_MANIFEST_PATH" ]; then
  echo "ERROR: change-manifest.json not found at $CHANGE_MANIFEST_PATH"
  exit 1
fi

# Read allChanged flag (defaults to false if not present)
ALL_CHANGED=$(jq -r '.allChanged // false' "$CHANGE_MANIFEST_PATH")
CHANGED_COUNT=$(jq -r '.changedTemplates | length' "$CHANGE_MANIFEST_PATH")

echo "Changed template count: $CHANGED_COUNT"
echo "All changed flag: $ALL_CHANGED"

# Handle empty manifest with allChanged=false: produce skipped report
if [ "$CHANGED_COUNT" = "0" ] && [ "$ALL_CHANGED" != "true" ]; then
  echo "No templates changed and allChanged is false. Skipping validation."
  jq -n '{summary: {totalTemplates: 0, passed: 0, failed: 0, status: "skipped"}, results: []}' > validation-report.json
  cat validation-report.json
  exit 0
fi

# Determine template paths to validate
TEMPLATE_PATHS="[]"

if [ "$ALL_CHANGED" = "true" ]; then
  echo "allChanged is true: enumerating all templates from stack-mapping.json"
  if [ ! -f "$STACK_MAPPING_PATH" ]; then
    echo "ERROR: stack-mapping.json not found at $STACK_MAPPING_PATH"
    exit 1
  fi
  # Extract all templatePath values from stack-mapping.json
  TEMPLATE_PATHS=$(jq '[.[].templatePath]' "$STACK_MAPPING_PATH")
else
  # Use changedTemplates from the manifest
  TEMPLATE_PATHS=$(jq '[.changedTemplates[].templatePath]' "$CHANGE_MANIFEST_PATH")
fi

TEMPLATE_COUNT=$(echo "$TEMPLATE_PATHS" | jq 'length')
echo "Templates to validate: $TEMPLATE_COUNT"

# Initialize results
RESULTS="[]"
FAILED=0
PASSED=0

# Function to call validate-template API with retry logic
validate_template_api() {
  local TEMPLATE_FILE="$1"
  local FILE_SIZE
  FILE_SIZE=$(stat -f%z "$TEMPLATE_FILE" 2>/dev/null || stat --printf="%s" "$TEMPLATE_FILE" 2>/dev/null)

  local MAX_RETRIES=3
  local RETRY_COUNT=0
  local BACKOFF=1

  # Check file size - if > 51200 bytes, report warning and skip API validation
  if [ "$FILE_SIZE" -gt 51200 ]; then
    echo "  WARNING: Template exceeds 51,200 bytes ($FILE_SIZE bytes). Skipping API validation (URL-based not implemented)."
    echo "warning"
    return 0
  fi

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    local API_OUTPUT
    API_OUTPUT=$(aws cloudformation validate-template --template-body "file://$TEMPLATE_FILE" 2>&1)
    local EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
      echo "pass"
      return 0
    fi

    # Check if error is transient (Throttling or RequestTimeout)
    if echo "$API_OUTPUT" | grep -qiE "(Throttling|RequestTimeout|ThrottlingException|RequestTimeoutException)"; then
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        echo "  Transient error detected. Retrying in \${BACKOFF}s (attempt $RETRY_COUNT/$MAX_RETRIES)..." >&2
        sleep $BACKOFF
        BACKOFF=$((BACKOFF * 2))
      else
        echo "  Transient error persisted after $MAX_RETRIES retries." >&2
        echo "$API_OUTPUT"
        return 1
      fi
    else
      # Non-transient error — return immediately
      echo "$API_OUTPUT"
      return 1
    fi
  done

  echo "$API_OUTPUT"
  return 1
}

# Validate each template
for i in $(seq 0 $(($TEMPLATE_COUNT - 1))); do
  TEMPLATE_PATH=$(echo "$TEMPLATE_PATHS" | jq -r ".[$i]")
  FULL_PATH="$SOURCE_DIR/$TEMPLATE_PATH"

  echo ""
  echo "--- Validating: $TEMPLATE_PATH ---"

  ERRORS="[]"
  TEMPLATE_STATUS="passed"

  # Step 1: Check file existence
  if [ ! -f "$FULL_PATH" ]; then
    echo "  ERROR: File not found: $TEMPLATE_PATH"
    ERRORS=$(echo "$ERRORS" | jq --arg msg "Template file not found: $TEMPLATE_PATH" '. + [{"errorType": "file_not_found", "message": $msg}]')
    TEMPLATE_STATUS="failed"
    FAILED=$((FAILED + 1))
    RESULTS=$(echo "$RESULTS" | jq --arg tp "$TEMPLATE_PATH" --arg st "$TEMPLATE_STATUS" --argjson errs "$ERRORS" '. + [{"templatePath": $tp, "status": $st, "errors": $errs}]')
    continue
  fi

  # Step 2: Parse as JSON (check syntax)
  JSON_ERROR=$(jq '.' "$FULL_PATH" 2>&1 >/dev/null)
  if [ $? -ne 0 ]; then
    echo "  ERROR: Invalid JSON syntax"
    echo "  $JSON_ERROR"
    ERRORS=$(echo "$ERRORS" | jq --arg msg "$JSON_ERROR" '. + [{"errorType": "json_syntax", "message": $msg}]')
    TEMPLATE_STATUS="failed"
    FAILED=$((FAILED + 1))
    RESULTS=$(echo "$RESULTS" | jq --arg tp "$TEMPLATE_PATH" --arg st "$TEMPLATE_STATUS" --argjson errs "$ERRORS" '. + [{"templatePath": $tp, "status": $st, "errors": $errs}]')
    continue
  fi

  # Step 3: Validate structure - check for "Resources" key
  HAS_RESOURCES=$(jq 'has("Resources")' "$FULL_PATH")
  if [ "$HAS_RESOURCES" != "true" ]; then
    echo "  ERROR: Missing required top-level \"Resources\" key"
    ERRORS=$(echo "$ERRORS" | jq '. + [{"errorType": "missing_resources", "message": "Template is missing the required top-level \\"Resources\\" key"}]')
    TEMPLATE_STATUS="failed"
  fi

  # Step 4: Check all top-level keys are valid CFN keys
  TOP_LEVEL_KEYS=$(jq -r 'keys[]' "$FULL_PATH")
  INVALID_KEYS=""
  for KEY in $TOP_LEVEL_KEYS; do
    IS_VALID=false
    for VALID_KEY in $VALID_CFN_KEYS; do
      if [ "$KEY" = "$VALID_KEY" ]; then
        IS_VALID=true
        break
      fi
    done
    if [ "$IS_VALID" = "false" ]; then
      if [ -z "$INVALID_KEYS" ]; then
        INVALID_KEYS="$KEY"
      else
        INVALID_KEYS="$INVALID_KEYS, $KEY"
      fi
    fi
  done

  if [ -n "$INVALID_KEYS" ]; then
    echo "  ERROR: Invalid top-level keys: $INVALID_KEYS"
    ERRORS=$(echo "$ERRORS" | jq --arg keys "$INVALID_KEYS" '. + [{"errorType": "invalid_top_level_key", "message": ("Template contains invalid top-level keys: " + $keys), "location": $keys}]')
    TEMPLATE_STATUS="failed"
  fi

  # If static checks failed, record result and continue
  if [ "$TEMPLATE_STATUS" = "failed" ]; then
    FAILED=$((FAILED + 1))
    RESULTS=$(echo "$RESULTS" | jq --arg tp "$TEMPLATE_PATH" --arg st "$TEMPLATE_STATUS" --argjson errs "$ERRORS" '. + [{"templatePath": $tp, "status": $st, "errors": $errs}]')
    continue
  fi

  # Step 5: Call aws cloudformation validate-template API
  echo "  Running CloudFormation validate-template API..."
  API_RESULT=$(validate_template_api "$FULL_PATH")
  API_EXIT=$?

  if [ "$API_RESULT" = "warning" ]; then
    # Large file warning — still counts as passed for now
    echo "  Template passed static checks (API validation skipped due to size)."
    PASSED=$((PASSED + 1))
    RESULTS=$(echo "$RESULTS" | jq --arg tp "$TEMPLATE_PATH" --arg st "passed" --argjson errs "$ERRORS" '. + [{"templatePath": $tp, "status": $st, "errors": $errs}]')
  elif [ "$API_RESULT" = "pass" ]; then
    echo "  Template passed all validation checks."
    PASSED=$((PASSED + 1))
    RESULTS=$(echo "$RESULTS" | jq --arg tp "$TEMPLATE_PATH" --arg st "passed" --argjson errs "$ERRORS" '. + [{"templatePath": $tp, "status": $st, "errors": $errs}]')
  else
    echo "  ERROR: CloudFormation validate-template API failed"
    echo "  $API_RESULT"
    ERRORS=$(echo "$ERRORS" | jq --arg msg "$API_RESULT" '. + [{"errorType": "api_error", "message": $msg}]')
    TEMPLATE_STATUS="failed"
    FAILED=$((FAILED + 1))
    RESULTS=$(echo "$RESULTS" | jq --arg tp "$TEMPLATE_PATH" --arg st "$TEMPLATE_STATUS" --argjson errs "$ERRORS" '. + [{"templatePath": $tp, "status": $st, "errors": $errs}]')
  fi
done

# Determine overall status
if [ $TEMPLATE_COUNT -eq 0 ]; then
  OVERALL_STATUS="skipped"
elif [ $FAILED -gt 0 ]; then
  OVERALL_STATUS="failed"
else
  OVERALL_STATUS="passed"
fi

# Write validation report
jq -n \\
  --argjson total "$TEMPLATE_COUNT" \\
  --argjson passed "$PASSED" \\
  --argjson failed "$FAILED" \\
  --arg status "$OVERALL_STATUS" \\
  --argjson results "$RESULTS" \\
  '{summary: {totalTemplates: $total, passed: $passed, failed: $failed, status: $status}, results: $results}' > validation-report.json

echo ""
echo "=== Validation Complete ==="
echo "Total: $TEMPLATE_COUNT, Passed: $PASSED, Failed: $FAILED, Status: $OVERALL_STATUS"
echo ""
echo "Validation report:"
cat validation-report.json

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "ERROR: One or more templates failed validation."
  exit 1
fi
SCRIPT
chmod +x /tmp/validate-templates.sh`,

          '/tmp/validate-templates.sh',
        ],
      },
    },
    artifacts: {
      'base-directory': '.',
      files: ['validation-report.json'],
    },
  });
}
