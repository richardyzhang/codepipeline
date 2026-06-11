/**
 * Utility functions for cross-account folder-based CloudFormation deployments.
 *
 * These functions are used as reference implementations for the shell script
 * logic embedded in the buildspec generators, and can be consumed directly
 * in CDK construct logic or tests.
 */

/**
 * Derives a CloudFormation stack name from a template path using folder-based naming.
 *
 * Uses the immediate parent folder and the filename without extension,
 * separated by a hyphen. The result is sanitized for CloudFormation naming
 * rules: `[a-zA-Z][-a-zA-Z0-9]*`, max 128 characters.
 *
 * If the template path has no parent folder (no `/`), the filename without
 * extension is used directly.
 *
 * @param templatePath - Relative path like "dev/ec2.json" or "nested/deep/vpc.json"
 * @returns Stack name like "dev-ec2" or "deep-vpc"
 */
export function deriveStackName(templatePath: string): string {
  const parts = templatePath.split('/');
  const filename = parts[parts.length - 1].replace(/\.[^.]*$/, ''); // strip extension

  let rawName: string;
  if (parts.length >= 2) {
    const folder = parts[parts.length - 2]; // immediate parent folder
    rawName = `${folder}-${filename}`;
  } else {
    rawName = filename;
  }

  // Replace characters not matching [a-zA-Z0-9-] with a hyphen
  let sanitized = rawName.replace(/[^a-zA-Z0-9-]/g, '-');

  // Prepend 'cfn-' if the first character is not a letter
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = `cfn-${sanitized}`;
  }

  // Truncate to 128 characters
  if (sanitized.length > 128) {
    sanitized = sanitized.slice(0, 128);
  }

  return sanitized;
}

/**
 * Extracts the folder name (first path segment) from a template path.
 *
 * @param templatePath - Relative path like "dev/ec2.json"
 * @returns Folder name like "dev"
 */
export function extractFolder(templatePath: string): string {
  const firstSlash = templatePath.indexOf('/');
  if (firstSlash === -1) {
    return '';
  }
  return templatePath.slice(0, firstSlash);
}

/**
 * Returns true if the file path ends with `.json` (case-insensitive).
 *
 * @param filePath - File path to check
 * @returns true if the path ends with .json
 */
export function isJsonTemplate(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json');
}

/**
 * Returns true when the target account differs from the pipeline account,
 * indicating that a cross-account role assumption is needed.
 *
 * @param targetAccountId - The AWS account to deploy to
 * @param pipelineAccountId - The AWS account running the pipeline
 * @returns true if role assumption is required
 */
export function shouldAssumeRole(targetAccountId: string, pipelineAccountId: string): boolean {
  return targetAccountId !== pipelineAccountId;
}

/**
 * Builds the IAM role ARN for the cross-account execution role.
 *
 * @param targetAccountId - The 12-digit AWS account ID
 * @returns Role ARN like "arn:aws:iam::237713356231:role/githubExecutionRole"
 */
export function buildRoleArn(targetAccountId: string): string {
  return `arn:aws:iam::${targetAccountId}:role/githubExecutionRole`;
}
