import * as codebuild from 'aws-cdk-lib/aws-codebuild';

/**
 * Generates the buildspec for the Change Detection CodeBuild project.
 *
 * The buildspec reads a comma-separated list of template paths from the
 * CHANGED_FILES environment variable (passed as a pipeline parameter)
 * and writes change-manifest.json.
 *
 * Stack names are derived from the filename without extension.
 * e.g., "templates/vpc.yaml" → stack name "vpc"
 *
 * If CHANGED_FILES is empty or "ALL", the build fails with an error
 * since there's no stack-mapping.json to enumerate all templates.
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

CHANGED_FILES_INPUT="$1"

# CHANGED_FILES must be provided
if [ -z "$CHANGED_FILES_INPUT" ] || [ "$CHANGED_FILES_INPUT" = "ALL" ]; then
  echo "ERROR: CHANGED_FILES must be a comma-separated list of template paths (e.g., templates/vpc.yaml,templates/ecs.yaml)"
  exit 1
fi

echo "Processing changed files: $CHANGED_FILES_INPUT"

# Convert comma-separated list to JSON array
CHANGED_TEMPLATES=$(echo "$CHANGED_FILES_INPUT" | tr ',' '\\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | jq -R . | jq -s '.')

# Build the manifest JSON using jq
jq -n --argjson templates "$CHANGED_TEMPLATES" '{changedTemplates: $templates, allChanged: false}' > change-manifest.json

echo "Change manifest:"
cat change-manifest.json
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
